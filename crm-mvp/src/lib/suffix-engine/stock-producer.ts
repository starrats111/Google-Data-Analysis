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
    },
  })) as CampaignForReplenish | null

  if (!campaign) {
    return { campaignId: cid, skipped: true, reason: 'campaign_not_found', before: 0, generated: 0, after: 0, failed: 0 }
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

  const persist = async (suffix: string): Promise<boolean> => {
    if (existingSuffixes.has(suffix)) return false
    existingSuffixes.add(suffix)
    await prisma.suffix_pool.create({
      data: {
        user_id: campaign.user_id,
        campaign_id: campaignId,
        suffix_content: suffix,
        status: 'available',
        source_merchant_id: merchant.id,
        expires_at: expiresAt,
      },
    })
    return true
  }

  // ── probe：先探一条 ──
  const probe = await generateOneSuffix(affiliateUrl, country, platform, { userId: campaign.user_id })
  if (!probe.ok) {
    failed++
    await emitGenFailureAlert(campaign, merchant.merchant_name, affiliateUrl, probe)
    return { campaignId: cid, skipped: false, reason: 'probe_failed', before, generated: 0, after: before, failed }
  }
  if (await persist(probe.suffix)) generated++

  // ── batch：成功后批量生成剩余 ──
  const remaining = need - 1
  if (remaining > 0) {
    let consecutiveFail = 0
    let circuitOpen = false
    await runWithConcurrency(remaining, STOCK_CONFIG.CONCURRENCY, async () => {
      if (circuitOpen) return
      const r = await generateOneSuffix(affiliateUrl, country, platform, { userId: campaign.user_id })
      if (r.ok) {
        consecutiveFail = 0
        if (await persist(r.suffix)) generated++
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
 * 批量补货：扫描最近有 lease 活动且库存偏低的广告系列，逐个补货。
 * 供 /api/cron/suffix-replenish 调用。
 */
export async function replenishLowStock(
  opts: { maxCampaigns?: number } = {},
): Promise<{ scanned: number; replenished: number; results: ReplenishResult[] }> {
  const maxCampaigns = opts.maxCampaigns ?? STOCK_CONFIG.CRON_MAX_CAMPAIGNS
  const activeSince = new Date(Date.now() - STOCK_CONFIG.ACTIVE_WINDOW_HOURS * 3600_000)

  // 最近有 lease 活动的广告系列
  const recent = await prisma.suffix_assignments.groupBy({
    by: ['campaign_id'],
    where: { created_at: { gte: activeSince }, is_deleted: 0 },
    _max: { created_at: true },
    orderBy: { _max: { created_at: 'desc' } },
    take: maxCampaigns,
  })

  const results: ReplenishResult[] = []
  let replenished = 0

  for (const row of recent) {
    const available = await prisma.suffix_pool.count({
      where: { campaign_id: row.campaign_id, status: 'available', is_deleted: 0 },
    })
    if (available > STOCK_CONFIG.LOW_WATERMARK) continue
    const r = await replenishCampaign(row.campaign_id)
    results.push(r)
    if ((r.generated ?? 0) > 0) replenished++
  }

  return { scanned: recent.length, replenished, results }
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
