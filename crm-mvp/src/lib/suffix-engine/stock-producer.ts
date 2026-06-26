/**
 * 换链接库存补货引擎（CRM 原生，借鉴 kylink stock-producer 编排）
 *
 * 核心流程 replenishCampaign：
 *   1. 加载广告系列 + 关联商家联盟链接 + 投放国
 *   2. 计算缺口 need = TARGET_STOCK - 现有可用库存
 *   3. probe：先生成 1 条；失败立即熔断并告警（坏链接/坏代理/商家库缺失）
 *   4. batch：成功后按并发批量生成剩余，去重后写入 suffix_pool(available)
 *   5. 补货成功自动解决该系列的 low_stock / replenish_failed 告警
 *
 * 通过进程内 Map 锁避免同一系列被并发补货（lease 触发 + cron 触发可能同时发生）。
 */

import { prisma } from '@/lib/prisma'
import { STOCK_CONFIG } from './config'
import { generateOneSuffix, type GenFailure } from './suffix-generator'
import { raiseAlert, resolveAlertsByType } from './alerts'
import { recordExitIp } from './exit-ip'

const inflight = new Map<string, Promise<ReplenishResult>>()

export interface ReplenishResult {
  campaignId: string
  skipped?: boolean
  reason?: string
  before: number
  generated: number
  after: number
  failed: number
}

interface CampaignForReplenish {
  id: bigint
  user_id: bigint
  user_merchant_id: bigint
  target_country: string
  suffix_exchange_enabled: number
  is_deleted: number
  campaign_name: string | null
  status: string | null
  google_status: string | null
  google_campaign_id: string | null
}

/** 简单并发限制器 */
async function runWithConcurrency<T>(
  count: number,
  limit: number,
  worker: (index: number) => Promise<T>,
): Promise<T[]> {
  const results: T[] = []
  let next = 0
  const runners = Array.from({ length: Math.min(limit, count) }, async () => {
    while (true) {
      const i = next++
      if (i >= count) break
      results[i] = await worker(i)
    }
  })
  await Promise.all(runners)
  return results
}

/**
 * 对单个广告系列补货。带进程内锁，重复调用返回同一进行中的 Promise。
 * @param opts.target 覆盖目标水位（默认 STOCK_CONFIG.TARGET_STOCK）
 * @param opts.force 忽略低水位判断强制补到目标
 */
export async function replenishCampaign(
  campaignId: bigint,
  opts: { target?: number; force?: boolean } = {},
): Promise<ReplenishResult> {
  const key = campaignId.toString()
  const existing = inflight.get(key)
  if (existing) return existing

  const task = doReplenish(campaignId, opts).finally(() => {
    inflight.delete(key)
  })
  inflight.set(key, task)
  return task
}

async function doReplenish(
  campaignId: bigint,
  opts: { target?: number; force?: boolean },
): Promise<ReplenishResult> {
  const cid = campaignId.toString()
  const target = Math.max(1, opts.target ?? STOCK_CONFIG.TARGET_STOCK)

  const campaign = (await prisma.campaigns.findFirst({
    where: { id: campaignId, is_deleted: 0 },
    select: {
      id: true,
      user_id: true,
      user_merchant_id: true,
      target_country: true,
      suffix_exchange_enabled: true,
      is_deleted: true,
      campaign_name: true,
      status: true,
      google_status: true,
      google_campaign_id: true,
    },
  })) as CampaignForReplenish | null

  if (!campaign) {
    return { campaignId: cid, skipped: true, reason: 'campaign_not_found', before: 0, generated: 0, after: 0, failed: 0 }
  }
  // 仅对「已启用」广告系列补货/告警：active + Google ENABLED + 已真正投放(有 gcid)。
  // 否则暂停/草稿广告会被脚本租用触发补货并刷出告警（用户反馈：告警成未启用广告）。
  const isEnabled =
    campaign.status === 'active' &&
    campaign.google_status === 'ENABLED' &&
    !!campaign.google_campaign_id
  if (!isEnabled) {
    return { campaignId: cid, skipped: true, reason: 'campaign_not_enabled', before: 0, generated: 0, after: 0, failed: 0 }
  }
  if (!campaign.suffix_exchange_enabled) {
    return { campaignId: cid, skipped: true, reason: 'exchange_disabled', before: 0, generated: 0, after: 0, failed: 0 }
  }

  const before = await prisma.suffix_pool.count({
    where: { campaign_id: campaignId, status: 'available', is_deleted: 0 },
  })

  let need = target - before
  if (!opts.force && before > STOCK_CONFIG.LOW_WATERMARK) {
    return { campaignId: cid, skipped: true, reason: 'stock_sufficient', before, generated: 0, after: before, failed: 0 }
  }
  need = Math.min(Math.max(need, 0), STOCK_CONFIG.MAX_PER_REPLENISH)
  if (need <= 0) {
    return { campaignId: cid, skipped: true, reason: 'no_need', before, generated: 0, after: before, failed: 0 }
  }

  // 加载商家联盟链接 + 平台
  const merchant = await prisma.user_merchants.findFirst({
    where: { id: campaign.user_merchant_id, is_deleted: 0 },
    select: { id: true, platform: true, tracking_link: true, merchant_name: true },
  })

  if (!merchant || !merchant.tracking_link) {
    await raiseAlert(campaign.user_id, {
      type: 'merchant_not_found',
      campaignId,
      level: 'error',
      message: merchant
        ? `商家「${merchant.merchant_name}」缺少联盟追踪链接（tracking_link），无法生成换链接库存`
        : `广告系列「${campaign.campaign_name ?? cid}」关联的商家在商家库中不存在`,
      context: {
        campaignName: campaign.campaign_name,
        userMerchantId: campaign.user_merchant_id.toString(),
        platform: merchant?.platform ?? null,
      },
    })
    return { campaignId: cid, skipped: true, reason: 'merchant_not_found', before, generated: 0, after: before, failed: 0 }
  }

  const affiliateUrl = merchant.tracking_link
  const country = campaign.target_country
  const platform = merchant.platform

  // 已有 available suffix 内容集合，用于去重
  const existingSuffixes = new Set(
    (
      await prisma.suffix_pool.findMany({
        where: { campaign_id: campaignId, status: 'available', is_deleted: 0 },
        select: { suffix_content: true },
      })
    ).map((r) => r.suffix_content),
  )

  const expiresAt =
    STOCK_CONFIG.EXPIRE_HOURS > 0 ? new Date(Date.now() + STOCK_CONFIG.EXPIRE_HOURS * 3600_000) : null

  let generated = 0
  let failed = 0
  const failures: GenFailure[] = []

  const persist = async (suffix: string, exitIp: string | null): Promise<boolean> => {
    if (existingSuffixes.has(suffix)) return false
    existingSuffixes.add(suffix)
    await prisma.suffix_pool.create({
      data: {
        user_id: campaign.user_id,
        campaign_id: campaignId,
        suffix_content: suffix,
        status: 'available',
        source_merchant_id: merchant.id,
        exit_ip: exitIp,
        expires_at: expiresAt,
      },
    })
    // 记录出口 IP（24h 去重）：成功入库才记，下条生成即可避开
    if (exitIp) await recordExitIp(campaign.user_id, campaignId, exitIp)
    return true
  }

  // ── probe：先探一条 ──
  const probe = await generateOneSuffix(affiliateUrl, country, platform, { userId: campaign.user_id, campaignId })
  if (!probe.ok) {
    failed++
    await emitGenFailureAlert(campaign, merchant.merchant_name, affiliateUrl, probe)
    return { campaignId: cid, skipped: false, reason: 'probe_failed', before, generated: 0, after: before, failed }
  }
  if (await persist(probe.suffix, probe.exitIp)) generated++

  // ── batch：成功后批量生成剩余 ──
  const remaining = need - 1
  if (remaining > 0) {
    let consecutiveFail = 0
    let circuitOpen = false
    await runWithConcurrency(remaining, STOCK_CONFIG.CONCURRENCY, async () => {
      if (circuitOpen) return
      const r = await generateOneSuffix(affiliateUrl, country, platform, { userId: campaign.user_id, campaignId })
      if (r.ok) {
        consecutiveFail = 0
        if (await persist(r.suffix, r.exitIp)) generated++
      } else {
        failed++
        consecutiveFail++
        failures.push(r)
        if (consecutiveFail >= STOCK_CONFIG.CIRCUIT_FAIL_THRESHOLD) circuitOpen = true
      }
    })
  }

  const after = before + generated

  if (generated === 0) {
    // 批量全失败
    const sample = failures[0]
    await raiseAlert(campaign.user_id, {
      type: 'replenish_failed',
      campaignId,
      level: 'error',
      message: `广告系列「${campaign.campaign_name ?? cid}」补货失败（尝试 ${failed} 次全部失败）：${sample?.error ?? '未知原因'}`,
      context: {
        campaignName: campaign.campaign_name,
        platform,
        country,
        affiliateUrl: affiliateUrl.slice(0, 300),
        reason: sample?.reason,
      },
    })
  } else {
    // 有产出：解决该系列旧的库存类告警
    await resolveAlertsByType(campaign.user_id, campaignId, ['low_stock', 'replenish_failed', 'invalid_link', 'merchant_not_found'])
    // 若产出仍不足低水位，记一条 low_stock（warning）
    if (after <= STOCK_CONFIG.LOW_WATERMARK) {
      await raiseAlert(campaign.user_id, {
        type: 'low_stock',
        campaignId,
        level: 'warning',
        message: `广告系列「${campaign.campaign_name ?? cid}」库存偏低（当前 ${after}，目标 ${target}），补货产出不足`,
        context: { campaignName: campaign.campaign_name, country, generated, failed },
      })
    }
  }

  return { campaignId: cid, skipped: false, before, generated, after, failed }
}

/** 跟链失败 → 落「链接无效」告警 */
async function emitGenFailureAlert(
  campaign: CampaignForReplenish,
  merchantName: string | null,
  affiliateUrl: string,
  fail: GenFailure,
): Promise<void> {
  const cid = campaign.id.toString()
  const ctx = {
    campaignName: campaign.campaign_name,
    merchantName,
    country: campaign.target_country,
    affiliateUrl: affiliateUrl.slice(0, 300),
    reason: fail.reason,
    finalUrl: fail.finalUrl ?? null,
  }

  // resolve_failed / no_tracking / forbidden_network / timeout / bad_input → 链接无效类
  await raiseAlert(campaign.user_id, {
    type: 'invalid_link',
    campaignId: campaign.id,
    level: 'error',
    message: `广告系列「${campaign.campaign_name ?? cid}」联盟链接无效：${fail.error}`,
    context: ctx,
  })
}

/**
 * 批量补货：扫描「全部已启用换链广告系列」，对可用库存低于低水位的自动补货。
 * 供 /api/cron/suffix-replenish 调用（每 5 分钟）。
 *
 * 注意：不再以「最近有 lease 活动」为前提——否则新启用 / 低流量 / 库存早已耗尽
 * （租不到→无新租用记录→掉出活跃窗口）的系列将永远得不到补货。
 * 改为覆盖所有已启用系列，按库存升序（最紧急优先）取前 maxCampaigns 个补货，
 * 其余低库存系列由下一轮 cron 接续，自然分摊低配生产机负载。
 */
export async function replenishLowStock(
  opts: { maxCampaigns?: number } = {},
): Promise<{ scanned: number; lowStock: number; replenished: number; results: ReplenishResult[] }> {
  const maxCampaigns = opts.maxCampaigns ?? STOCK_CONFIG.CRON_MAX_CAMPAIGNS

  // 1. 所有已启用换链系列：active + Google ENABLED + 已真正投放(有 gcid) + 换链开 + 已匹配商家
  const enabled = await prisma.campaigns.findMany({
    where: {
      status: 'active',
      google_status: 'ENABLED',
      google_campaign_id: { not: null },
      suffix_exchange_enabled: 1,
      is_deleted: 0,
      user_merchant_id: { not: BigInt(0) },
    },
    select: { id: true },
  })
  if (enabled.length === 0) return { scanned: 0, lowStock: 0, replenished: 0, results: [] }
  const ids = enabled.map((c) => c.id)

  // 2. 一次 groupBy 取每系列当前可用库存（避免 N 次 count）
  const stockRows = await prisma.suffix_pool.groupBy({
    by: ['campaign_id'],
    where: { campaign_id: { in: ids }, status: 'available', is_deleted: 0 },
    _count: { _all: true },
  })
  const stockMap = new Map(stockRows.map((r) => [r.campaign_id.toString(), r._count._all]))

  // 3. 低于低水位的（含 0 库存 / 无记录），按库存升序，最紧急优先，限额保护
  const low = ids
    .map((id) => ({ id, stock: stockMap.get(id.toString()) ?? 0 }))
    .filter((x) => x.stock <= STOCK_CONFIG.LOW_WATERMARK)
    .sort((a, b) => a.stock - b.stock)

  const targets = low.slice(0, maxCampaigns)

  // 时间预算：单轮最多跑 ~4 分钟即收尾返回，剩余低库存系列交给下一轮 cron 接续，
  // 避免单轮在低配机上无限拉长、长时间阻塞后续补货轮次（补货是逐条等代理的 I/O）。
  const DEADLINE_MS = 240_000
  const startedAt = Date.now()

  const results: ReplenishResult[] = []
  let replenished = 0
  for (const c of targets) {
    if (Date.now() - startedAt > DEADLINE_MS) break
    const r = await replenishCampaign(c.id)
    results.push(r)
    if ((r.generated ?? 0) > 0) replenished++
  }

  return { scanned: enabled.length, lowStock: low.length, replenished, results }
}

/**
 * 后缀生命周期回收：
 *   1) available 且已过 expires_at → expired（避免投放到失效 clickid/token）
 *   2) leased 超 LEASE_STALE_HOURS 仍无回执（Script 没 report）→ expired，释放占坑
 * 供 /api/cron/suffix-replenish 每轮顺带调用。返回各自回收条数。
 */
export async function recycleSuffixes(): Promise<{ expiredAvailable: number; reclaimedLeased: number }> {
  const now = new Date()
  let expiredAvailable = 0
  let reclaimedLeased = 0
  try {
    const r1 = await prisma.suffix_pool.updateMany({
      where: { status: 'available', is_deleted: 0, expires_at: { not: null, lt: now } },
      data: { status: 'expired' },
    })
    expiredAvailable = r1.count
  } catch (e) {
    console.warn('[stock-producer] recycle available 失败:', e instanceof Error ? e.message : e)
  }
  try {
    const staleBefore = new Date(now.getTime() - STOCK_CONFIG.LEASE_STALE_HOURS * 3600_000)
    const r2 = await prisma.suffix_pool.updateMany({
      where: { status: 'leased', is_deleted: 0, created_at: { lt: staleBefore } },
      data: { status: 'expired', leased_assignment_id: null },
    })
    reclaimedLeased = r2.count
  } catch (e) {
    console.warn('[stock-producer] recycle leased 失败:', e instanceof Error ? e.message : e)
  }
  return { expiredAvailable, reclaimedLeased }
}

/** 触发某系列的异步补货（fire-and-forget），lease NO_STOCK / 低库存时调用 */
export function triggerReplenishAsync(campaignId: bigint, opts: { force?: boolean } = {}): void {
  replenishCampaign(campaignId, opts).catch((err) => {
    console.error('[stock-producer] async replenish failed:', campaignId.toString(), err instanceof Error ? err.message : err)
  })
}

/** 单系列库存统计 */
export async function getCampaignStock(campaignId: bigint) {
  const [available, leased, consumed] = await Promise.all([
    prisma.suffix_pool.count({ where: { campaign_id: campaignId, status: 'available', is_deleted: 0 } }),
    prisma.suffix_pool.count({ where: { campaign_id: campaignId, status: 'leased', is_deleted: 0 } }),
    prisma.suffix_pool.count({ where: { campaign_id: campaignId, status: 'consumed', is_deleted: 0 } }),
  ])
  return { available, leased, consumed, target: STOCK_CONFIG.TARGET_STOCK, lowWatermark: STOCK_CONFIG.LOW_WATERMARK }
}
