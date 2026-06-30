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
import { resolveMerchantReferer } from './referer-resolver'

const inflight = new Map<string, Promise<ReplenishResult>>()

/**
 * 失败冷却表（进程内，PM2 单进程常驻，跨 cron 轮次保留）。
 * campaignId → 在此 epoch(ms) 之前不再被 cron 选中补货。
 *
 * 解决「队列饿死」：replenishLowStock 按库存升序取前 N 个，库存恒为 0 的
 * 常败系列（坏链/难解析/商家缺失）每轮都排在队首，且失败探针最长 75s，
 * 4 分钟预算被它们烧光，导致 900+ 健康系列永远轮不到补货。
 * 失败后置入冷却，到期前跳过，把预算让给健康系列；到期自动重试。
 */
const failCooldown = new Map<string, number>()
/** probe/批量失败的冷却时长（坏链多为代理波动，30min 后重试一次） */
const FAIL_COOLDOWN_MS = 30 * 60_000
/** 商家缺失/缺链接的冷却时长（属数据问题，2h 重试一次即可） */
const MERCHANT_COOLDOWN_MS = 2 * 60 * 60_000

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
  // 用户级闸门：jy 交垟队等「只同步数据、不参与换链接」的账号(link_exchange_disabled=1)一律不补货，
  // 避免其系列被 lease 触发或 cron 选中后空跑生成、白烧低配机预算并刷 no_tracking/invalid_link 告警。
  const owner = await prisma.users.findUnique({
    where: { id: campaign.user_id },
    select: { link_exchange_disabled: true },
  })
  if (owner?.link_exchange_disabled === 1) {
    return { campaignId: cid, skipped: true, reason: 'user_exchange_disabled', before: 0, generated: 0, after: 0, failed: 0 }
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
  // 「从 Google 侧回填」的广告系列入库时 user_merchant_id 先置 0，待 syncMerchantStatusForUser
  // 按 (平台,MID) 关联商家。若该商家尚未进 CRM 商家库，则一直为 0。此类系列不应被当作可换链：
  // 静默跳过、不触发生成、更不报 merchant_not_found 告警（否则脚本每轮 lease→force 补货都刷一条，
  // 把告警中心淹没——批量补货 replenishLowStock / 刷点击 startBrushAllTasks 早有此闸，单系列路径此前漏了）。
  if (!campaign.user_merchant_id || campaign.user_merchant_id <= BigInt(0)) {
    return { campaignId: cid, skipped: true, reason: 'merchant_not_linked', before: 0, generated: 0, after: 0, failed: 0 }
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

  if (!merchant) {
    // 孤儿引用：user_merchant_id>0 但商家行已不存在（换平台账号后旧商家被同步清理，或尚未重新同步进库）。
    // 静默跳过、不报警——此类已在「换链接管理」列表显示为「未匹配商家」，并会由商家同步 + 自动关联修复；
    // 反复报 merchant_not_found 只会刷屏（user_merchant_id<=0 已在前置闸门拦下，这里专治 orphan）。
    return { campaignId: cid, skipped: true, reason: 'merchant_missing', before, generated: 0, after: before, failed: 0 }
  }
  if (!merchant.tracking_link) {
    // 商家在库但缺联盟追踪链接：补货路径一律静默跳过、不再报警。
    // 「断链是否要人工处理」的判定统一交给 /api/cron/merchant-link-health：
    // 只有「该商家近 30 天有真实交易(affiliate_transactions)却仍断链」才升级为高优先告警，
    // 其余视为「仍在自愈流程中」（商家同步 / Google 回拉 / 手动填链接会修复），静默不刷屏。
    return { campaignId: cid, skipped: true, reason: 'merchant_no_tracking_link', before, generated: 0, after: before, failed: 0 }
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

  // 来路（Referer）：手动来路 → 最新文章 → 联盟账号网站 → （空则不带 Referer）。
  // 与刷点击同源，让补货追链也带上真实来路，提升联盟点击归因。整条补货解析一次复用。
  const refererUrl = (await resolveMerchantReferer(merchant.id)).url

  // ── probe：先探一条 ──
  const probe = await generateOneSuffix(affiliateUrl, country, platform, { userId: campaign.user_id, campaignId, referer: refererUrl })
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
      const r = await generateOneSuffix(affiliateUrl, country, platform, { userId: campaign.user_id, campaignId, referer: refererUrl })
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

  // 用户级闸门：排除「只同步数据、不参与换链接」的账号(link_exchange_disabled=1，如 jy 交垟队)，
  // 这些用户的系列即便 suffix_exchange_enabled=1 也不补货，从源头不进补货队列。
  const disabledUsers = await prisma.users.findMany({
    where: { link_exchange_disabled: 1, is_deleted: 0 },
    select: { id: true },
  })
  const disabledUserIds = disabledUsers.map((u) => u.id)

  // 1. 所有已启用换链系列：active + Google ENABLED + 已真正投放(有 gcid) + 换链开 + 已匹配商家
  const enabled = await prisma.campaigns.findMany({
    where: {
      status: 'active',
      google_status: 'ENABLED',
      google_campaign_id: { not: null },
      suffix_exchange_enabled: 1,
      is_deleted: 0,
      user_merchant_id: { not: BigInt(0) },
      ...(disabledUserIds.length > 0 ? { user_id: { notIn: disabledUserIds } } : {}),
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

  // 3. 低于低水位的（含 0 库存 / 无记录），按库存升序，最紧急优先，限额保护。
  //    跳过仍在失败冷却期内的系列（常败系列不再每轮霸占预算，让位给健康系列）。
  const now = Date.now()
  const lowAll = ids
    .map((id) => ({ id, stock: stockMap.get(id.toString()) ?? 0 }))
    .filter((x) => x.stock <= STOCK_CONFIG.LOW_WATERMARK)
    .sort((a, b) => a.stock - b.stock)

  const low = lowAll.filter((x) => (failCooldown.get(x.id.toString()) ?? 0) <= now)
  // 清理已过期的冷却项，避免 Map 无限增长
  for (const [k, until] of failCooldown) if (until <= now) failCooldown.delete(k)

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
    const key = c.id.toString()
    if ((r.generated ?? 0) > 0) {
      replenished++
      failCooldown.delete(key) // 成功产出：清除冷却
    } else if (r.reason === 'merchant_missing' || r.reason === 'merchant_no_tracking_link' || r.reason === 'merchant_not_linked') {
      // 商家断链（孤儿 / 缺链接 / 未关联）：长冷却，避免每轮重复扫描；
      // 是否需人工处理由 /api/cron/merchant-link-health 按「有无交易」分流判定。
      failCooldown.set(key, Date.now() + MERCHANT_COOLDOWN_MS)
    } else if (r.skipped !== true || r.reason === 'probe_failed') {
      // probe_failed / 批量全失败（skipped=false, generated=0）→ 失败冷却
      failCooldown.set(key, Date.now() + FAIL_COOLDOWN_MS)
    }
  }

  return { scanned: enabled.length, lowStock: lowAll.length, replenished, results }
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
