/**
 * 需求2：订单/点击比控制刷点击 —— 决策引擎（定版）
 *
 * 目标：让「订单/点击」落在 5%~10%（即每订单 10~20 次联盟点击），避免转化率过高被联盟风控。
 *
 * 逻辑（每个「已启用换链、已匹配带追踪链接商家」的广告系列）：
 *   O = 当天该商家联盟订单数（affiliate_transactions，UTC+8 切日）
 *   C = 当天该商家真实联盟点击（affiliate_click_daily）+ 我们已排程/已执行但可能尚未回流到聚合表的点击
 *   B = 过去 7 天该商家联盟点击日均（affiliate_click_daily，排除今天）；每小时补点击上限 = ⌊B/4⌋
 *   若 C ≥ O×10 → 不刷；否则 目标 T = O×rand(10,20)，本小时实补 = min(T−C, ⌊B/4⌋ − 本小时已排程)，
 *   余量留待下一小时续补。补刷复用 click-brush，1 小时窗口内随机分散、真人化。
 *
 * 触发：订单同步后（ontxn，见 txn-quick-sync 钩子）；仅对开启 click_control_enabled 的用户生效。
 */

import prisma from '@/lib/prisma'
import { todayCST, parseCSTDateStart, parseCSTDateEndExclusive } from '@/lib/date-utils'
import { normalizePlatformCode } from '@/lib/constants'
import { PLATFORM_CLICK_CONFIG } from '@/lib/platform-api'
import { randomInt } from '@/lib/suffix-engine/click-scheduler'
import { startBrushTaskWindowed } from '@/lib/suffix-engine/click-brush'

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

  // 候选系列：已启用换链、已匹配商家
  const campaigns = await prisma.campaigns.findMany({
    where: {
      user_id: userId,
      status: 'active',
      google_status: 'ENABLED',
      is_deleted: 0,
      suffix_exchange_enabled: 1,
      user_merchant_id: { not: BigInt(0) },
    },
    select: { id: true, user_merchant_id: true, campaign_name: true },
  })
  if (campaigns.length === 0) return res

  // 关联商家（platform / merchant_id / tracking_link）
  const merchantIds = [...new Set(campaigns.map((c) => c.user_merchant_id).filter((id): id is bigint => !!id && id > BigInt(0)))]
  const merchants = await prisma.user_merchants.findMany({
    where: { id: { in: merchantIds }, user_id: userId, is_deleted: 0 },
    select: { id: true, platform: true, merchant_id: true, tracking_link: true, campaign_link: true },
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
  const hourStart = new Date(now)
  hourStart.setMinutes(0, 0, 0)
  const hourEnd = new Date(hourStart.getTime() + 3600_000)
  const windowMinutes = Math.max(1, Math.ceil((hourEnd.getTime() - now.getTime()) / 60_000))

  for (const c of campaigns) {
    const merchant = c.user_merchant_id ? merchantById.get(c.user_merchant_id.toString()) : undefined
    if (!merchant) continue
    const platform = normalizePlatformCode(merchant.platform || '')
    const mid = merchant.merchant_id || ''
    if (!platform || !mid) continue
    if (!PLATFORM_CLICK_CONFIG[platform]) continue // 无点击 API 的平台无法控比，跳过
    if (!(merchant.tracking_link?.trim() || merchant.campaign_link?.trim())) continue // 无链接无法刷

    if (onlyMerchantKeys && !onlyMerchantKeys.has(`${platform}:${mid}`)) continue

    res.campaignsConsidered++

    // O：当天订单数
    const O = await prisma.affiliate_transactions.count({
      where: {
        user_id: userId,
        platform,
        merchant_id: mid,
        is_deleted: 0,
        transaction_time: { gte: todayStartUTC, lt: todayEndUTC },
      },
    })
    if (O <= 0) {
      res.skippedNoOrders++
      continue
    }

    // C：当天真实点击（聚合表）
    const todayAgg = await prisma.affiliate_click_daily.aggregate({
      where: { user_id: userId, platform, merchant_id: mid, click_date: todayDate, is_deleted: 0 },
      _sum: { clicks: true },
    })
    const realClicksToday = todayAgg._sum.clicks ?? 0

    // 我们今天已排程/执行的点击（按系列 → 任务 → 子项）
    const todayTasks = await prisma.kyads_click_tasks.findMany({
      where: { campaign_id: c.id, user_id: userId, is_deleted: 0, created_at: { gte: todayStartUTC } },
      select: { id: true },
    })
    const todayTaskIds = todayTasks.map((t) => t.id)
    let ourSuccessToday = 0
    let ourPendingToday = 0
    let scheduledThisHour = 0
    if (todayTaskIds.length > 0) {
      ;[ourSuccessToday, ourPendingToday, scheduledThisHour] = await Promise.all([
        prisma.kyads_click_task_items.count({ where: { task_id: { in: todayTaskIds }, status: 'success', is_deleted: 0 } }),
        prisma.kyads_click_task_items.count({ where: { task_id: { in: todayTaskIds }, status: { in: ['pending', 'executing'] }, is_deleted: 0 } }),
        prisma.kyads_click_task_items.count({ where: { task_id: { in: todayTaskIds }, is_deleted: 0, scheduled_at: { gte: hourStart, lt: hourEnd } } }),
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

    // 基线 B：过去 7 天日均（排除今天）；无历史时用今日真实点击兜底，仍为 0 则无法安全定量 → 跳过
    const baseAgg = await prisma.affiliate_click_daily.aggregate({
      where: { user_id: userId, platform, merchant_id: mid, is_deleted: 0, click_date: { in: baselineDates } },
      _sum: { clicks: true },
    })
    const baselineSum = baseAgg._sum.clicks ?? 0
    const avg7 = baselineSum / BASELINE_DAYS
    const baseline = Math.max(avg7, realClicksToday)
    const hourlyCap = Math.floor(baseline / HOURLY_DIVISOR)
    if (hourlyCap <= 0) {
      res.skippedNoBaseline++
      res.details.push(`${platform}:${mid} O=${O} C=${effectiveC} 无基线(B=${baseline.toFixed(1)})→跳过`)
      continue
    }

    // 目标 T = O×rand(cpoMin,cpoMax)；本小时实补 = min(T−C, 小时上限剩余)
    const T = O * randomInt(cpoMin, cpoMax)
    const deficit = T - effectiveC
    if (deficit <= 0) {
      res.skippedRatioOk++
      continue
    }
    const hourlyRemaining = Math.max(0, hourlyCap - scheduledThisHour)
    const thisHour = Math.min(deficit, hourlyRemaining)
    if (thisHour <= 0) {
      res.details.push(`${platform}:${mid} O=${O} C=${effectiveC} 缺${deficit} 但本小时已达上限(${hourlyCap})→下小时续补`)
      continue
    }

    const r = await startBrushTaskWindowed(c.id, userId, thisHour, windowMinutes)
    if (r.ok) {
      res.scheduled++
      res.clicksScheduled += r.target
      res.details.push(`${platform}:${mid} O=${O} C=${effectiveC} T=${T} 本小时补${r.target}(上限${hourlyCap})`)
    } else {
      res.details.push(`${platform}:${mid} 补刷失败: ${r.message}`)
    }
  }

  return res
}
