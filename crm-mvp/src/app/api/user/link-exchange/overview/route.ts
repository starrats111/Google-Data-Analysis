import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { getUserFromRequest } from '@/lib/auth'
import { getAlertSummary } from '@/lib/suffix-engine/alerts'
import { STOCK_CONFIG } from '@/lib/suffix-engine/config'
import { parseCampaignNameFull } from '@/lib/campaign-merchant-link'
import { normalizePlatformCode } from '@/lib/constants'

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
    link_status: true,
    link_check_reason: true,
    tracking_status: true,
    parent_check_reason: true,
    parent_network: true,
    parent_blacklisted: true,
  } as const

  // 巡航结果(tracking_status) 是换链接系统实际维护的权威链接状态，统一映射到前端的 valid/invalid/unchecked；
  // tracking_status 为空才回退到 daily-merchant-check 写的 link_status（基础可达性）。
  const deriveLinkStatus = (m: {
    tracking_status: string | null
    link_status: string | null
  }): string => {
    switch (m.tracking_status) {
      case 'ok':
        return 'valid'
      case 'forbidden_network':
      case 'no_tracking':
      case 'resolve_failed':
        return 'invalid'
      default:
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
    select: { script_api_key: true, link_exchange_click_count: true },
  })

  const { summary: alertSummary, totalOpen } = await getAlertSummary(userId)

  const totalAvailable = rows.reduce((s, r) => s + r.stock.available, 0)
  const lowStockCount = rows.filter((r) => r.matched && r.suffixEnabled && r.lowStock).length

  return NextResponse.json({
    code: 0,
    data: {
      rows,
      apiKey: apiKeyRecord?.script_api_key ?? null,
      defaultClickCount: apiKeyRecord?.link_exchange_click_count ?? 10,
      summary: {
        total: rows.length,
        matched: rows.filter((r) => r.matched).length,
        totalAvailable,
        lowStockCount,
        alertOpen: totalOpen,
      },
      alertSummary,
      stockConfig: { target: STOCK_CONFIG.TARGET_STOCK, lowWatermark: STOCK_CONFIG.LOW_WATERMARK },
    },
  })
}
