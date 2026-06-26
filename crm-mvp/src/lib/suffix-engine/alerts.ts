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
      select: { id: true, occur_count: true },
    })

    if (existing) {
      await prisma.suffix_alerts.update({
        where: { id: existing.id },
        data: {
          occur_count: existing.occur_count + 1,
          last_seen_at: new Date(),
          level,
          message: message.slice(0, 500),
          context: (context ?? undefined) as Prisma.InputJsonValue | undefined,
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

/** 手动解决指定告警 */
export async function resolveAlerts(userId: bigint, ids: bigint[]): Promise<number> {
  if (ids.length === 0) return 0
  const res = await prisma.suffix_alerts.updateMany({
    where: { user_id: userId, id: { in: ids }, is_deleted: 0 },
    data: { status: 'resolved', resolved_at: new Date() },
  })
  return res.count
}

export interface ListAlertsParams {
  status?: 'open' | 'resolved'
  type?: SuffixAlertType
  limit?: number
  offset?: number
}

export async function listAlerts(userId: bigint, params: ListAlertsParams = {}) {
  const { status, type, limit = 50, offset = 0 } = params
  const where = {
    user_id: userId,
    is_deleted: 0,
    ...(status ? { status } : {}),
    ...(type ? { type } : {}),
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

/** 告警中心概览计数（按 type 统计 open 数量） */
export async function getAlertSummary(userId: bigint) {
  const rows = await prisma.suffix_alerts.groupBy({
    by: ['type'],
    where: { user_id: userId, status: 'open', is_deleted: 0 },
    _count: { _all: true },
  })
  const summary: Record<string, number> = {
    invalid_link: 0,
    merchant_not_found: 0,
    low_stock: 0,
    replenish_failed: 0,
  }
  let totalOpen = 0
  for (const r of rows) {
    summary[r.type] = r._count._all
    totalOpen += r._count._all
  }
  return { summary, totalOpen }
}
