import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { getUserFromRequest } from '@/lib/auth'
import { getAlertSummary } from '@/lib/suffix-engine/alerts'
import { STOCK_CONFIG } from '@/lib/suffix-engine/config'
import { parseCampaignNameFull } from '@/lib/campaign-merchant-link'
import { normalizePlatformCode } from '@/lib/constants'
import { todayCST, parseCSTDateStart, parseCSTDateEndExclusive } from '@/lib/date-utils'

export async function GET(req: NextRequest) {
  const user = await getUserFromRequest(req)
  if (!user) return NextResponse.json({ code: -1, message: '未登录' }, { status: 401 })

  const userId = BigInt(user.userId)

  const campaigns = await prisma.campaigns.findMany({
    // 仅真正投放到 Google 的广告系列（有 google_campaign_id）；排除未发布的草稿（DRAFT-...）
    where: { user_id: userId, status: 'active', is_deleted: 0, google_campaign_id: { not: null } },
    select: {
      id: true,
      google_campaign_id: true,
      campaign_name: true,
      target_country: true,
      google_status: true,
      user_merchant_id: true,
      suffix_exchange_enabled: true,
      suffix_last_apply_at: true,
      suffix_last_content: true,
    },
    orderBy: { campaign_name: 'asc' },
  })

  // 解析广告系列名 → 平台/MID（权威解析器：规范化平台代码、无白名单、MID 必须为数字）
  const parsed = campaigns.map((c) => {
    const p = parseCampaignNameFull(c.campaign_name ?? '')
    return {
      ...c,
      platform: p?.platform ?? '',
      mid: p?.mid ?? '',
      country: c.target_country || p?.country || '',
    }
  })

  // 商家精准提取：优先权威关联 campaigns.user_merchant_id，回退按 (平台, MID) 名称匹配
  const umIds = [...new Set(parsed.map((p) => p.user_merchant_id).filter((id) => id && id > BigInt(0)))]
  const mids = [...new Set(parsed.filter((p) => p.mid).map((p) => p.mid))]
  const platforms = [...new Set(parsed.filter((p) => p.platform).map((p) => p.platform))]

  const merchantSelect = {
    id: true,
    merchant_id: true,
    platform: true,
    merchant_name: true,
    tracking_link: true,
    campaign_link: true,
    link_status: true,
    link_check_reason: true,
    tracking_status: true,
    parent_check_reason: true,
    parent_network: true,
    parent_blacklisted: true,
    kyads_referer_url: true,
    platform_connection_id: true,
  } as const

  // 巡航结果(tracking_status) 映射到前端状态。关键：resolve_failed/no_tracking 多为
  // 代理/TLS/超时等巡航基础设施失败（实测 99 个 resolve_failed 中 91 个 link_status=valid、
  // 链接直连可达），不能等同于「链接无效」，否则会把大量可用链接误标红。
  // - ok                        → valid（有效）
  // - forbidden_network         → invalid（命中上级联盟黑名单，真无效/硬拦截）
  // - resolve_failed/no_tracking→ 基础检测已判坏(link_status=invalid)才算 invalid；否则 recheck（待验证，巡航未通过，会重试）
  // - 未巡航(unchecked)         → 无任何链接 → no_link（缺链接）；有链接 → 回退 link_status
  const deriveLinkStatus = (m: {
    tracking_status: string | null
    link_status: string | null
    tracking_link: string | null
    campaign_link: string | null
  }): string => {
    switch (m.tracking_status) {
      case 'ok':
        return 'valid'
      case 'forbidden_network':
        return 'invalid'
      case 'no_tracking':
      case 'resolve_failed':
        return m.link_status === 'invalid' ? 'invalid' : 'recheck'
      default:
        if (!m.tracking_link && !m.campaign_link) return 'no_link'
        return m.link_status ?? 'unchecked'
    }
  }

  const merchants =
    umIds.length > 0 || mids.length > 0
      ? await prisma.user_merchants.findMany({
          where: {
            user_id: userId,
            is_deleted: 0,
            OR: [
              ...(umIds.length > 0 ? [{ id: { in: umIds } }] : []),
              ...(mids.length > 0 ? [{ merchant_id: { in: mids }, platform: { in: platforms } }] : []),
            ],
          },
          select: merchantSelect,
        })
      : []
  const merchantById = new Map(merchants.map((m) => [m.id.toString(), m]))
  const merchantByKey = new Map(merchants.map((m) => [`${normalizePlatformCode(m.platform)}:${m.merchant_id}`, m]))

  // ── 今日(北京时间) 联盟点击 / 订单（按 平台:商家ID）——「点击数/订单数/转化率」列，与控比引擎同口径 ──
  // 转化率 = 订单/点击；点击取自 affiliate_click_daily（联盟平台真实点击），订单取自 affiliate_transactions。
  const todayStr = todayCST()
  const todayClickDate = new Date(`${todayStr}T00:00:00Z`)
  const todayStartUTC = parseCSTDateStart(todayStr)
  const todayEndUTC = parseCSTDateEndExclusive(todayStr)
  const clicksByKey = new Map<string, number>()
  const ordersByKey = new Map<string, number>()
  if (merchants.length > 0) {
    const [clickRows, orderRows] = await Promise.all([
      prisma.affiliate_click_daily.groupBy({
        by: ['platform', 'merchant_id'],
        where: { user_id: userId, is_deleted: 0, click_date: todayClickDate },
        _sum: { clicks: true },
      }),
      prisma.affiliate_transactions.groupBy({
        by: ['platform', 'merchant_id'],
        where: { user_id: userId, is_deleted: 0, transaction_time: { gte: todayStartUTC, lt: todayEndUTC } },
        _count: { _all: true },
      }),
    ])
    for (const r of clickRows) clicksByKey.set(`${normalizePlatformCode(r.platform)}:${r.merchant_id}`, r._sum.clicks ?? 0)
    for (const r of orderRows) ordersByKey.set(`${normalizePlatformCode(r.platform)}:${r.merchant_id}`, r._count._all)
  }

  // ── 来路来源批量预取（与 referer-resolver 同口径）：文章 published_url / 联盟账号绑定网站 domain ──
  const allMerchantIds = merchants.map((m) => m.id)
  const latestArticleByMerchant = new Map<string, string>()
  if (allMerchantIds.length > 0) {
    const arts = await prisma.articles.findMany({
      where: { user_merchant_id: { in: allMerchantIds }, status: 'published', published_url: { not: null }, is_deleted: 0 },
      orderBy: { published_at: 'desc' },
      select: { user_merchant_id: true, published_url: true },
    })
    for (const a of arts) {
      if (!a.user_merchant_id || !a.published_url) continue
      const k = a.user_merchant_id.toString()
      if (!latestArticleByMerchant.has(k)) latestArticleByMerchant.set(k, a.published_url)
    }
  }
  const connIds = [...new Set(merchants.map((m) => m.platform_connection_id).filter((x): x is bigint => !!x))]
  const siteIdByConn = new Map<string, bigint>()
  if (connIds.length > 0) {
    const conns = await prisma.platform_connections.findMany({
      where: { id: { in: connIds }, is_deleted: 0 },
      select: { id: true, publish_site_id: true },
    })
    for (const c of conns) if (c.publish_site_id) siteIdByConn.set(c.id.toString(), c.publish_site_id)
  }
  const siteIds = [...new Set([...siteIdByConn.values()])]
  const domainBySite = new Map<string, string>()
  if (siteIds.length > 0) {
    const sites = await prisma.publish_sites.findMany({
      where: { id: { in: siteIds }, is_deleted: 0 },
      select: { id: true, domain: true },
    })
    for (const s of sites) if (s.domain) domainBySite.set(s.id.toString(), s.domain)
  }

  // 单条商家来路解析（优先级：手动 → 文章 → 网站 → 无）
  const resolveReferer = (
    m: { id: bigint; kyads_referer_url: string | null; platform_connection_id: bigint | null } | null,
  ): { url: string | null; source: 'manual' | 'article' | 'website' | 'none' } => {
    if (!m) return { url: null, source: 'none' }
    const manual = m.kyads_referer_url?.trim()
    if (manual) return { url: manual, source: 'manual' }
    const art = latestArticleByMerchant.get(m.id.toString())
    if (art) return { url: art, source: 'article' }
    if (m.platform_connection_id) {
      const siteId = siteIdByConn.get(m.platform_connection_id.toString())
      const domain = siteId ? domainBySite.get(siteId.toString())?.trim() : undefined
      if (domain) {
        const d = domain.replace(/\/+$/, '')
        return { url: /^https?:\/\//i.test(d) ? d : `https://${d}`, source: 'website' }
      }
    }
    return { url: null, source: 'none' }
  }

  // 按 campaign_id + status 统计库存
  const campaignIds = campaigns.map((c) => c.id)
  const stockRows =
    campaignIds.length > 0
      ? await prisma.suffix_pool.groupBy({
          by: ['campaign_id', 'status'],
          where: { campaign_id: { in: campaignIds }, is_deleted: 0 },
          _count: { _all: true },
        })
      : []
  const stockMap = new Map<string, { available: number; leased: number; consumed: number }>()
  for (const r of stockRows) {
    const key = r.campaign_id.toString()
    const cur = stockMap.get(key) ?? { available: 0, leased: 0, consumed: 0 }
    if (r.status === 'available') cur.available = r._count._all
    else if (r.status === 'leased') cur.leased = r._count._all
    else if (r.status === 'consumed') cur.consumed = r._count._all
    stockMap.set(key, cur)
  }

  // 每个 campaign 最新刷点击任务（JS 去重取最新，展示进度）
  const allClickTasks =
    campaignIds.length > 0
      ? await prisma.kyads_click_tasks.findMany({
          where: { campaign_id: { in: campaignIds }, is_deleted: 0 },
          orderBy: { created_at: 'desc' },
          select: { campaign_id: true, status: true, target_count: true, done_count: true, finished_at: true },
        })
      : []
  const clickTaskMap = new Map<string, (typeof allClickTasks)[0]>()
  for (const t of allClickTasks) {
    const key = t.campaign_id.toString()
    if (!clickTaskMap.has(key)) clickTaskMap.set(key, t)
  }

  const rows = parsed.map((c) => {
    // 先用权威关联取商家，未关联再按名称解析的 (平台, MID) 回退匹配
    const merchant =
      (c.user_merchant_id && c.user_merchant_id > BigInt(0)
        ? merchantById.get(c.user_merchant_id.toString())
        : null) ??
      (c.platform && c.mid ? merchantByKey.get(`${c.platform}:${c.mid}`) : null) ??
      null
    const stock = stockMap.get(c.id.toString()) ?? { available: 0, leased: 0, consumed: 0 }
    const clickTask = clickTaskMap.get(c.id.toString()) ?? null
    const referer = resolveReferer(merchant)
    // 今日点击/订单/转化率（按商家口径；同一商家的多个系列展示相同值）
    const mkey = merchant
      ? `${normalizePlatformCode(merchant.platform)}:${merchant.merchant_id}`
      : (c.platform && c.mid ? `${c.platform}:${c.mid}` : '')
    const todayClicks = mkey ? (clicksByKey.get(mkey) ?? 0) : 0
    const todayOrders = mkey ? (ordersByKey.get(mkey) ?? 0) : 0
    const conversion = todayClicks > 0 ? todayOrders / todayClicks : null // 订单/点击；无点击为 null（前端显示 —）
    return {
      campaignId: c.id.toString(),
      googleCampaignId: c.google_campaign_id,
      campaignName: c.campaign_name,
      country: c.country,
      googleStatus: c.google_status,
      platform: c.platform || (merchant ? normalizePlatformCode(merchant.platform) : ''),
      mid: c.mid || merchant?.merchant_id || '',
      matched: !!merchant,
      merchantId: merchant?.id.toString() ?? null,
      merchantName: merchant?.merchant_name ?? null,
      trackingLink: merchant?.tracking_link ?? null,
      linkStatus: merchant ? deriveLinkStatus(merchant) : 'unchecked',
      linkCheckReason: merchant?.parent_check_reason ?? merchant?.link_check_reason ?? null,
      parentNetwork: merchant?.parent_network ?? null,
      parentBlacklisted: merchant?.parent_blacklisted === 1,
      suffixEnabled: c.suffix_exchange_enabled === 1,
      todayClicks,
      todayOrders,
      conversion,
      refererUrl: referer.url,
      refererSource: referer.source,
      lastApplyAt: c.suffix_last_apply_at,
      lastSuffix: c.suffix_last_content,
      stock,
      lowStock: stock.available <= STOCK_CONFIG.LOW_WATERMARK,
      clickTask: clickTask
        ? {
            status: clickTask.status,
            target: clickTask.target_count,
            done: clickTask.done_count,
            finishedAt: clickTask.finished_at,
          }
        : null,
    }
  })

  const apiKeyRecord = await prisma.users.findUnique({
    where: { id: userId },
    select: {
      script_api_key: true,
      link_exchange_click_count: true,
      click_control_enabled: true,
      click_control_ratio_min_pct: true,
      click_control_ratio_max_pct: true,
      script_loop_interval_seconds: true,
    },
  })

  const { summary: alertSummary, totalOpen } = await getAlertSummary(userId)

  // 顶部统计与「链接管理 / 库存管理」列表口径保持一致：只统计已启用
  // (Google Ads ENABLED / 默认) 的广告系列，排除 PAUSED/REMOVED 等未在投系列。
  const enabledRows = rows.filter((r) => (r.googleStatus ?? 'ENABLED') === 'ENABLED')
  const totalAvailable = enabledRows.reduce((s, r) => s + r.stock.available, 0)
  const lowStockCount = enabledRows.filter((r) => r.matched && r.suffixEnabled && r.lowStock).length

  return NextResponse.json({
    code: 0,
    data: {
      rows,
      apiKey: apiKeyRecord?.script_api_key ?? null,
      defaultClickCount: apiKeyRecord?.link_exchange_click_count ?? 10,
      clickControlEnabled: apiKeyRecord?.click_control_enabled === 1,
      clickControlRatio: {
        minPct: apiKeyRecord?.click_control_ratio_min_pct ?? 5,
        maxPct: apiKeyRecord?.click_control_ratio_max_pct ?? 10,
      },
      // 换链脚本轮询间隔(秒)：用户自助；null=默认15
      scriptLoopIntervalSeconds: apiKeyRecord?.script_loop_interval_seconds ?? null,
      scriptLoopIntervalDefault: 15,
      summary: {
        total: enabledRows.length,
        matched: enabledRows.filter((r) => r.matched).length,
        totalAvailable,
        lowStockCount,
        alertOpen: totalOpen,
      },
      alertSummary,
      stockConfig: { target: STOCK_CONFIG.TARGET_STOCK, lowWatermark: STOCK_CONFIG.LOW_WATERMARK },
    },
  })
}
