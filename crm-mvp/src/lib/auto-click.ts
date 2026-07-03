/**
 * 需求2：订单/点击比控制刷点击 —— 决策引擎（定版）
 *
 * 目标：让「订单/点击」落在 5%~10%（即每订单 10~20 次联盟点击），避免转化率过高被联盟风控。
 *
 * 逻辑（每个「已启用换链、已匹配带追踪链接商家」的广告系列，含已暂停——
 * 广告暂停后订单仍随 cookie 归因回传数天，同样必须按比例补点击，否则出现「只有订单没有点击」）：
 *   O = 当天该商家联盟订单数（affiliate_transactions，UTC+8 切日）
 *   C = 当天该商家真实联盟点击（affiliate_click_daily）+ 我们已排程/已执行但可能尚未回流到聚合表的点击
 *   目标 T = O×rand(cpoMin,cpoMax)：订单倒推「应有点击数」，使转化率落在用户区间内。
 *   缺口 deficit = T − C；deficit ≤ 0 不刷。
 *   B = 过去 7 天该商家联盟点击日均（排除今天）：仅作「当天基线总预算」封顶——当天累计 ≤ ⌊B/4⌋×剩余小时。
 *   ★ 基线为 0 不再跳过：有订单就按 T 补刷。补刷窗口固定 1 小时：本轮缺口在「未来 60 分钟内」
 *     随机分散执行，实现「订单传回 1 小时内刷完」（每 30min 的 txn-sync 触发一轮，effectiveC 含 pending 不会重复下单）。
 *   补刷复用 click-brush（startBrushTaskWindowed，windowMinutes=60）。
 *
 * 触发：订单同步后（ontxn，见 txn-quick-sync 钩子）；仅对开启 click_control_enabled 的用户生效。
 */

import prisma from '@/lib/prisma'
import { todayCST, parseCSTDateStart, parseCSTDateEndExclusive } from '@/lib/date-utils'
import { normalizePlatformCode } from '@/lib/constants'
import { PLATFORM_CLICK_CONFIG } from '@/lib/platform-api'
import { randomInt } from '@/lib/suffix-engine/click-scheduler'
import { startBrushTaskWindowed } from '@/lib/suffix-engine/click-brush'
import { pickCampaignAffiliateLink } from '@/lib/merchant-connection'

/** 转化率目标改为按用户配置（click_control_ratio_min/max_pct）运行时计算，默认 5%~10%（每订单 10~20 点击） */
/** 基线回看天数 */
const BASELINE_DAYS = 7
/** 每小时补点击上限 = 基线日均 / HOURLY_DIVISOR */
const HOURLY_DIVISOR = 4

/** UTC+8 日期串 → affiliate_click_daily.click_date 对应的 DATE */
function clickDateToDate(dateStr: string): Date {
  return new Date(`${dateStr}T00:00:00Z`)
}

export interface AutoClickResult {
  campaignsConsidered: number
  scheduled: number // 触发了补刷的系列数
  clicksScheduled: number // 排程的点击总数
  skippedRatioOk: number // C 已达标跳过
  skippedNoBaseline: number // 无基线数据跳过
  skippedNoOrders: number // 当天无订单跳过
  details: string[]
}

/**
 * 为某用户运行订单/点击比补刷。
 * @param onlyMerchantKeys 限定只处理这些「platform:merchant_id」（ontxn 钩子只传有新订单的商家）；不传=扫描全部启用系列
 */
export async function runAutoClickForUser(
  userId: bigint,
  onlyMerchantKeys?: Set<string>,
): Promise<AutoClickResult> {
  const res: AutoClickResult = {
    campaignsConsidered: 0,
    scheduled: 0,
    clicksScheduled: 0,
    skippedRatioOk: 0,
    skippedNoBaseline: 0,
    skippedNoOrders: 0,
    details: [],
  }

  // 用户级开关 + 转化率(订单/点击)区间配置
  const user = await prisma.users.findFirst({
    where: { id: userId, is_deleted: 0, status: 'active', click_control_enabled: 1 },
    select: { id: true, click_control_ratio_min_pct: true, click_control_ratio_max_pct: true },
  })
  if (!user) return res

  // 转化率区间(%) → 每订单点击数区间：cpoMin=100/maxPct, cpoMax=100/minPct
  // 例：5%~10% → 每订单 10~20 次点击。无效配置回退默认（RATIO_MIN/MAX）。
  const minPct = user.click_control_ratio_min_pct > 0 ? user.click_control_ratio_min_pct : 5
  const maxPct = user.click_control_ratio_max_pct > minPct ? user.click_control_ratio_max_pct : Math.max(minPct + 1, 10)
  const cpoMin = Math.max(1, Math.round(100 / maxPct)) // 达标所需最少点击/订单（C≥O×cpoMin ⇒ 转化率≤maxPct）
  const cpoMax = Math.max(cpoMin + 1, Math.round(100 / minPct)) // 补刷目标上限点击/订单

  // 候选系列：已启用换链、已匹配商家。
  // ★ active + paused 都参与：广告暂停后订单仍随 cookie 归因回传数天，联盟侧转化率风控
  //   与 Google 状态无关；只看 active 会造成「暂停商家只有订单没有点击」（wj02 Ballboyz 事故）。
  const allCampaigns = await prisma.campaigns.findMany({
    where: {
      user_id: userId,
      status: { in: ['active', 'paused'] },
      is_deleted: 0,
      suffix_exchange_enabled: 1,
      user_merchant_id: { not: BigInt(0) },
    },
    select: { id: true, user_merchant_id: true, campaign_name: true, platform_connection_id: true, status: true, google_status: true },
  })
  // 每个 (商家×连接) 只保留一个「载体」系列，优先 active+ENABLED > active > 最新的暂停系列，
  // 防止同商家多系列重复计算缺口、重复下任务。
  const rankOf = (c: { status: string; google_status: string | null }) =>
    c.status === 'active' && c.google_status === 'ENABLED' ? 2 : c.status === 'active' ? 1 : 0
  const byMerchantConn = new Map<string, (typeof allCampaigns)[number]>()
  const campaignIdsByKey = new Map<string, bigint[]>()
  for (const c of allCampaigns) {
    const key = `${c.user_merchant_id}:${c.platform_connection_id ?? 'null'}`
    const prev = byMerchantConn.get(key)
    if (!prev || rankOf(c) > rankOf(prev) || (rankOf(c) === rankOf(prev) && c.id > prev.id)) {
      byMerchantConn.set(key, c)
    }
    const ids = campaignIdsByKey.get(key) ?? []
    ids.push(c.id)
    campaignIdsByKey.set(key, ids)
  }
  const campaigns = [...byMerchantConn.values()]
  if (campaigns.length === 0) return res

  // 关联商家（platform / merchant_id / 各账号链接）
  const merchantIds = [...new Set(campaigns.map((c) => c.user_merchant_id).filter((id): id is bigint => !!id && id > BigInt(0)))]
  const merchants = await prisma.user_merchants.findMany({
    where: { id: { in: merchantIds }, user_id: userId, is_deleted: 0 },
    select: { id: true, platform: true, merchant_id: true, tracking_link: true, campaign_link: true, connection_campaign_links: true, platform_connection_id: true },
  })
  const merchantById = new Map(merchants.map((m) => [m.id.toString(), m]))

  // 时间边界
  const todayStr = todayCST()
  const todayStartUTC = parseCSTDateStart(todayStr)
  const todayEndUTC = parseCSTDateEndExclusive(todayStr)
  const todayDate = clickDateToDate(todayStr)
  const baselineDates: Date[] = []
  for (let i = 1; i <= BASELINE_DAYS; i++) {
    const d = new Date(`${todayStr}T00:00:00Z`)
    d.setUTCDate(d.getUTCDate() - i)
    baselineDates.push(d)
  }
  const now = new Date()

  for (const c of campaigns) {
    const merchant = c.user_merchant_id ? merchantById.get(c.user_merchant_id.toString()) : undefined
    if (!merchant) continue
    const platform = normalizePlatformCode(merchant.platform || '')
    const mid = merchant.merchant_id || ''
    if (!platform || !mid) continue
    if (!PLATFORM_CLICK_CONFIG[platform]) continue // 无点击 API 的平台无法控比，跳过

    // 该广告归属的联盟账号（连接）。建广告时写入，是「这条广告用哪个号」的唯一可靠依据。
    // NULL=存量未回填，pickCampaignAffiliateLink 回退旧逻辑（主连接/tracking_link）。
    const connId = c.platform_connection_id ?? null
    // 账号感知选链接：拿不到该号的链接就跳过（宁可不刷，也不刷到没配链接/别的号）
    const affiliateUrl = pickCampaignAffiliateLink(connId, merchant)
    if (!affiliateUrl) continue

    if (onlyMerchantKeys && !onlyMerchantKeys.has(`${platform}:${mid}`)) continue

    res.campaignsConsidered++

    // O：当天订单数（按该广告归属账号 platform_connection_id 归属；affiliate_transactions 每行带真实连接，
    // 可靠可拆）。没出单的号 O=0 直接跳过，不会被误补刷（wj02 CG1/CG2 串号根治点）。
    // connId=NULL（存量未回填）时不按连接拆，退化为商家级（合并口径），行为与旧版一致。
    const O = await prisma.affiliate_transactions.count({
      where: {
        user_id: userId,
        platform,
        merchant_id: mid,
        ...(connId != null ? { platform_connection_id: connId } : {}),
        is_deleted: 0,
        transaction_time: { gte: todayStartUTC, lt: todayEndUTC },
      },
    })
    if (O <= 0) {
      res.skippedNoOrders++
      continue
    }

    // C：当天真实点击（聚合表）。
    // 注意：affiliate_click_daily 唯一键为 (user_id, platform, merchant_id, click_date)，不含连接，
    // 同商家跨账号的点击被合并成一行，无法按 connId 拆分，故 C 保持商家级（合并口径）。
    // 影响仅为「保守」：合并 C 偏大 → 至多少补一点，绝不会导致刷到错号（错号已被 O=0 拦下）。
    const todayAgg = await prisma.affiliate_click_daily.aggregate({
      where: { user_id: userId, platform, merchant_id: mid, click_date: todayDate, is_deleted: 0 },
      _sum: { clicks: true },
    })
    const realClicksToday = todayAgg._sum.clicks ?? 0

    // 我们今天已排程/执行的点击（同商家×同连接的全部系列 → 任务 → 子项，避免载体系列切换后漏计已排点击）
    const keyForC = `${c.user_merchant_id}:${c.platform_connection_id ?? 'null'}`
    const siblingCampaignIds = campaignIdsByKey.get(keyForC) ?? [c.id]
    const todayTasks = await prisma.kyads_click_tasks.findMany({
      where: { campaign_id: { in: siblingCampaignIds }, user_id: userId, is_deleted: 0, created_at: { gte: todayStartUTC } },
      select: { id: true },
    })
    const todayTaskIds = todayTasks.map((t) => t.id)
    let ourSuccessToday = 0
    let ourPendingToday = 0
    if (todayTaskIds.length > 0) {
      ;[ourSuccessToday, ourPendingToday] = await Promise.all([
        prisma.kyads_click_task_items.count({ where: { task_id: { in: todayTaskIds }, status: 'success', is_deleted: 0 } }),
        prisma.kyads_click_task_items.count({ where: { task_id: { in: todayTaskIds }, status: { in: ['pending', 'executing'] }, is_deleted: 0 } }),
      ])
    }

    // 估算真实在途点击 C：
    //   max(聚合表今日, 我们今日已成功)  —— 聚合表回流后用其(含自然点击)，未回流时用我们成功数兜底
    //   + 我们今日待执行(pending/executing) —— 即将成为点击，计入避免重复补
    const effectiveC = Math.max(realClicksToday, ourSuccessToday) + ourPendingToday

    // 比值已达标（C ≥ O×cpoMin ⇒ 转化率 ≤ maxPct）→ 不刷
    if (effectiveC >= O * cpoMin) {
      res.skippedRatioOk++
      continue
    }

    // 目标 T = O×rand(cpoMin,cpoMax)：订单倒推「应有点击数」，使转化率(订单/点击)落在区间内。
    // 例：区间 5%~10% → 每订单 10~20 点击；O=2 → T=20~40。
    const T = O * randomInt(cpoMin, cpoMax)
    let deficit = T - effectiveC
    if (deficit <= 0) {
      res.skippedRatioOk++
      continue
    }

    // 基线 B：过去 7 天日均（排除今天）。仅用于「有历史」时的限速封顶（平均每小时 ≤ ⌊B/4⌋）。
    // 关键改动：基线为 0 不再跳过——有订单就按 T 补刷，只是把缺口「铺到当天剩余时段」分散执行，避免突增。
    const baseAgg = await prisma.affiliate_click_daily.aggregate({
      where: { user_id: userId, platform, merchant_id: mid, is_deleted: 0, click_date: { in: baselineDates } },
      _sum: { clicks: true },
    })
    const avg7 = (baseAgg._sum.clicks ?? 0) / BASELINE_DAYS
    const baseline = Math.max(avg7, realClicksToday)
    const hourlyCap = Math.floor(baseline / HOURLY_DIVISOR) // 0=无基线

    // 当天剩余小时数（北京时间到 24:00），仅用于「当天基线总预算」封顶（非补刷窗口）。
    const hoursLeft = Math.max(1, Math.ceil((todayEndUTC.getTime() - now.getTime()) / 3_600_000))

    // 有基线：当天累计不超过 ⌊B/4⌋×剩余小时（当天基线总预算上限，防止全天严重超刷）。
    // 补刷窗口已固定 1 小时（见下），此处仅作日预算天花板；订单倒推目标 T 通常很小，几乎不触顶。
    if (hourlyCap > 0) deficit = Math.min(deficit, hourlyCap * hoursLeft)
    if (deficit <= 0) {
      res.details.push(`${platform}:${mid} O=${O} C=${effectiveC} 受基线限速(${hourlyCap}/h)本轮不补`)
      continue
    }

    // 窗口固定 1 小时：本轮缺口在「未来 60 分钟内」随机分散补刷，实现「订单传回 1 小时内刷完」。
    // scheduler 在窗口内随机分散（真人化）；effectiveC 已含我方今日 pending，订单再次同步触发也不会重复下单。
    const windowMinutes = 60
    const r = await startBrushTaskWindowed(c.id, userId, deficit, windowMinutes)
    if (r.ok) {
      res.scheduled++
      res.clicksScheduled += r.target
      res.details.push(`${platform}:${mid} O=${O} C=${effectiveC} T=${T} 铺${r.target}点击/1h(基线${hourlyCap}/h)`)
    } else {
      res.details.push(`${platform}:${mid} 补刷失败: ${r.message}`)
    }
  }

  return res
}
