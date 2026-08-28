/**
 * 换链接告警中心
 *
 * 在补货 / lease / 跟链各环节捕获异常，写入 suffix_alerts 表，供「换链接管理」页的告警中心展示。
 * 同类告警（同 user + type + campaign）在未解决时收敛为一条，仅累加 occur_count 与 last_seen_at，
 * 避免坏链接/坏代理反复触发刷屏。
 */

import { prisma } from '@/lib/prisma'
import { Prisma } from '@/generated/prisma/client'

export type SuffixAlertType =
  | 'invalid_link' // 联盟链接无效 / 跟链失败 / 停在跳板域名
  | 'merchant_not_found' // 商家库找不到对应商家或缺少追踪链接
  | 'low_stock' // 库存持续偏低且补货跟不上
  | 'replenish_failed' // 补货批量全部失败
  | 'brush_blocked' // 有订单需当天净化转化率，但补刷无法进行（无链接/任务创建失败），需人工介入
  | 'link_forbidden' // 联盟跳板在自己的重定向端点返回 4xx（403 等）拒绝点击：商家目录仍在但 token 已失效/被停用，需人工到平台重新获取链接
  // D-299 与该商家已无合作关系：跳板 4xx 的拒绝页正文明说「No business partnership with merchants」。
  // 单列的理由是**处置与 link_forbidden 相反**——那个重新取一条链接就好，这个取多少次都还是 403，
  // 必须重新申请合作或下架系列。原先两者同报「需重新获取链接」，wj07 jymsupplementscience 因此
  // 被反复催了 2744 次、人照做也没用、广告一直在烧钱而佣金为零（07 2026-08-28 反馈「提示不到位」）。
  | 'merchant_partnership_ended'
  | 'no_tracking_stuck' // D-201 连续多轮跟链都落到商家官网但零追踪参数：链接「活着但不记点击」，此前无任何告警可覆盖，系列会静默死并每天白开上百次浏览器
  // D-230 补刷连续全败：有订单要净化、任务也建得出来，但排出去的点击一次都没成过。
  // 既有告警全是「链接层」的（跟链失败/被拒/零参数），补刷这一层的成功率此前无人看守——
  // 17 家死循环商家白烧 25,111 次点击，页面上一条告警都没有。熔断触发时同步抛出。
  | 'brush_failing'
  // D-212 Google Ads 脚本里的 API Key 与库里不一致，脚本调 /api/v1/* 全部 401。
  // 其余告警都由补货/跟链流程触发，而这些流程此时压根没被调用，页面上一片安静，
  // wj10 因此静默停摆一个月（621 单共用一个跟踪码）。挂用户维度，campaign_id 为 NULL。
  | 'script_auth_failed'
  // D-223 系列名的账号位次与该系列实际归属的联盟账号对不上（如名字改成 RW1、归属还停在 RW2）。
  // 改名只会同步 campaign_name，归属由 backfillCampaignConnections 管而它只填空值不覆盖，
  // 于是换链接继续按旧账号取链，佣金记到旧号上，页面「对应平台」只显示平台码看不出来。
  | 'connection_mismatch'

export type SuffixAlertLevel = 'info' | 'warning' | 'error'

export interface RaiseAlertInput {
  type: SuffixAlertType
  campaignId?: bigint | null
  level?: SuffixAlertLevel
  message: string
  context?: Record<string, unknown> | null
}

/**
 * 抛出（或收敛）一条告警。
 * 同 user+type+campaign 的 open 告警存在时累加计数，否则新建。
 */
export async function raiseAlert(userId: bigint, input: RaiseAlertInput): Promise<void> {
  const { type, campaignId = null, level = 'warning', message, context = null } = input
  try {
    const existing = await prisma.suffix_alerts.findFirst({
      where: {
        user_id: userId,
        type,
        campaign_id: campaignId,
        status: 'open',
        is_deleted: 0,
      },
      select: { id: true, occur_count: true, context: true },
    })

    if (existing) {
      // D-242：context 合并而非整体覆盖。link-heal 把自愈尝试计数/冷却时间存在告警 context 里
      // （heal* 前缀键），若这里仍整体覆盖，每 30 分钟一次的重报会把自愈状态清零，
      // 尝试上限（3 次）形同虚设，坏链接会被无限重拉。
      const prevCtx =
        existing.context && typeof existing.context === 'object' && !Array.isArray(existing.context)
          ? (existing.context as Record<string, unknown>)
          : null
      const mergedCtx = context ? { ...(prevCtx ?? {}), ...context } : undefined
      await prisma.suffix_alerts.update({
        where: { id: existing.id },
        data: {
          occur_count: existing.occur_count + 1,
          last_seen_at: new Date(),
          level,
          message: message.slice(0, 500),
          context: mergedCtx as Prisma.InputJsonValue | undefined,
        },
      })
      return
    }

    await prisma.suffix_alerts.create({
      data: {
        user_id: userId,
        campaign_id: campaignId,
        type,
        level,
        message: message.slice(0, 500),
        context: (context ?? undefined) as Prisma.InputJsonValue | undefined,
      },
    })
  } catch (err) {
    // 告警写入失败不应影响主流程
    console.error('[suffix-alerts] raiseAlert failed:', err instanceof Error ? err.message : err)
  }
}

/**
 * 标记某类告警已解决（如补货成功后自动清掉该系列的 low_stock / replenish_failed）。
 */
export async function resolveAlertsByType(
  userId: bigint,
  campaignId: bigint | null,
  types: SuffixAlertType[],
): Promise<void> {
  if (types.length === 0) return
  try {
    await prisma.suffix_alerts.updateMany({
      where: {
        user_id: userId,
        campaign_id: campaignId,
        type: { in: types },
        status: 'open',
        is_deleted: 0,
      },
      data: { status: 'resolved', resolved_at: new Date() },
    })
  } catch (err) {
    console.error('[suffix-alerts] resolveAlertsByType failed:', err instanceof Error ? err.message : err)
  }
}

/**
 * 收敛「僵尸告警」：系列已非 ENABLED（暂停/删除/CRM 已删）却仍挂着 open 告警。
 *
 * 背景：补货/巡检只处理 ENABLED 系列，不会去清这些已停投系列的旧告警。告警中心 UI 虽已按
 * ENABLED 过滤不展示它们（见 visibilityFilter），但它们会在 suffix_alerts 表里无限累积。
 * 由 5 分钟一轮的 suffix-replenish cron 顺带调用，从源头防止堆积。返回被解决的条数。
 */
export async function resolveAlertsForInactiveCampaigns(): Promise<number> {
  try {
    const affected = await prisma.$executeRaw`
      UPDATE suffix_alerts a
      JOIN campaigns c ON c.id = a.campaign_id
      SET a.status = 'resolved', a.resolved_at = NOW(), a.updated_at = NOW()
      WHERE a.status = 'open' AND a.is_deleted = 0 AND a.campaign_id IS NOT NULL
        AND (c.is_deleted = 1 OR c.status <> 'active' OR c.google_status IS NULL OR c.google_status <> 'ENABLED')
    `
    return (typeof affected === 'number' ? affected : 0) + (await resolveAlertsForExchangeDisabled())
  } catch (err) {
    console.error('[suffix-alerts] resolveAlertsForInactiveCampaigns failed:', err instanceof Error ? err.message : err)
    return 0
  }
}

/**
 * D-299.1 收敛「开关已关却还在报」的告警：系列的换链接开关(suffix_exchange_enabled)已关，
 * 但换链接流水线的旧告警仍挂在页面上。
 *
 * 背景（07 2026-08-28 反馈「频繁报错」的一大来源）：处理告警的标准动作之一就是
 * 「暂停广告 / 关掉换链开关，然后点已处理」。可关开关只是让流水线不再跑，**不会**清掉
 * 已经堆起来的告警——于是人以为处理完了，告警还在屏幕上待着，看起来永远处理不完。
 * 实测 45 个系列已关开关，却仍挂着 56 条告警、累计 6324 次报错。
 *
 * 为什么这些告警确实作废：补货(stock-producer)、刷点击(auto-click / click-brush)三条路径
 * 都硬过滤 `suffix_exchange_enabled = 1`，开关一关就都不再执行，告警描述的故障不可能再发生。
 *
 * ⚠️ 刻意不含 connection_mismatch：它讲的是「系列名里的账号与实际归属对不上」，
 * 影响的是佣金记在哪个联盟账号名下——广告还在投就依然成立，与换链接开关无关。
 */
async function resolveAlertsForExchangeDisabled(): Promise<number> {
  try {
    const affected = await prisma.$executeRaw`
      UPDATE suffix_alerts a
      JOIN campaigns c ON c.id = a.campaign_id
      SET a.status = 'resolved', a.resolved_at = NOW(), a.updated_at = NOW()
      WHERE a.status = 'open' AND a.is_deleted = 0 AND a.campaign_id IS NOT NULL
        AND c.suffix_exchange_enabled = 0
        AND a.type IN (
          'low_stock', 'replenish_failed', 'invalid_link', 'merchant_not_found',
          'link_forbidden', 'merchant_partnership_ended', 'no_tracking_stuck',
          'brush_blocked', 'brush_failing'
        )
    `
    return typeof affected === 'number' ? affected : 0
  } catch (err) {
    console.error('[suffix-alerts] resolveAlertsForExchangeDisabled failed:', err instanceof Error ? err.message : err)
    return 0
  }
}

/** 手动解决指定告警 */
export async function resolveAlerts(userId: bigint, ids: bigint[]): Promise<number> {
  if (ids.length === 0) return 0
  const res = await prisma.suffix_alerts.updateMany({
    where: { user_id: userId, id: { in: ids }, is_deleted: 0 },
    data: { status: 'resolved', resolved_at: new Date() },
  })
  return res.count
}

/**
 * 该用户「已启用」广告系列 id 集合（active + ENABLED + 有 google_campaign_id）。
 * 告警中心只统计这些系列相关的告警，避免把草稿/未启用广告的告警也算进来。
 */
async function getEnabledCampaignIds(userId: bigint): Promise<bigint[]> {
  const rows = await prisma.campaigns.findMany({
    where: {
      user_id: userId,
      status: 'active',
      google_status: 'ENABLED',
      is_deleted: 0,
      google_campaign_id: { not: null },
    },
    select: { id: true },
  })
  return rows.map((r) => r.id)
}

/**
 * 告警可见性过滤：仅保留「已启用广告系列」相关 + 无 campaign 绑定（通用）的告警。
 */
function visibilityFilter(enabledIds: bigint[]) {
  return {
    OR: [{ campaign_id: null }, { campaign_id: { in: enabledIds } }],
  }
}

export interface ListAlertsParams {
  status?: 'open' | 'resolved'
  type?: SuffixAlertType
  limit?: number
  offset?: number
}

export async function listAlerts(userId: bigint, params: ListAlertsParams = {}) {
  const { status, type, limit = 50, offset = 0 } = params
  const enabledIds = await getEnabledCampaignIds(userId)
  const where = {
    user_id: userId,
    is_deleted: 0,
    ...(status ? { status } : {}),
    ...(type ? { type } : {}),
    ...visibilityFilter(enabledIds),
  }
  const [rows, total] = await Promise.all([
    prisma.suffix_alerts.findMany({
      where,
      orderBy: [{ status: 'asc' }, { last_seen_at: 'desc' }],
      take: Math.min(limit, 200),
      skip: offset,
    }),
    prisma.suffix_alerts.count({ where }),
  ])
  return { rows, total }
}

/** 告警中心概览计数（按 type 统计 open 数量；仅含已启用广告系列相关告警） */
export async function getAlertSummary(userId: bigint) {
  const enabledIds = await getEnabledCampaignIds(userId)
  const rows = await prisma.suffix_alerts.groupBy({
    by: ['type'],
    where: { user_id: userId, status: 'open', is_deleted: 0, ...visibilityFilter(enabledIds) },
    _count: { _all: true },
  })
  const summary: Record<string, number> = {
    invalid_link: 0,
    merchant_not_found: 0,
    low_stock: 0,
    replenish_failed: 0,
    brush_blocked: 0,
    brush_failing: 0,
    link_forbidden: 0,
    merchant_partnership_ended: 0,
    no_tracking_stuck: 0,
    script_auth_failed: 0,
    connection_mismatch: 0,
  }
  let totalOpen = 0
  for (const r of rows) {
    summary[r.type] = r._count._all
    totalOpen += r._count._all
  }
  return { summary, totalOpen }
}
