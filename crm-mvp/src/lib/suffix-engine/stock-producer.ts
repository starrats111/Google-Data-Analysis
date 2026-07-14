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
import { pickCampaignAffiliateLink } from '@/lib/merchant-connection'
import { sameRootDomain } from '@/lib/root-domain'

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
/**
 * 「必须浏览器」系列的补货冷却表（进程内）。
 * suffix_needs_browser=1 的系列每生成一条都要整页跑无头浏览器（纯 HTTP 的几十倍代理流量），
 * 补完一轮后冷却 BROWSER_REPLENISH_COOLDOWN_MS，期间即便低于水位也不被 cron 选中，压低补货频率。
 * lease NO_STOCK 的 force 路径不受此表影响（真没货时仍可按需补）。
 */
const browserCooldown = new Map<string, number>()

export interface ReplenishResult {
  campaignId: string
  skipped?: boolean
  reason?: string
  before: number
  generated: number
  after: number
  failed: number
  /** 本轮 probe 观测：该系列是否必须无头浏览器才能跟链（仅 probe 成功的轮次有值） */
  needsBrowser?: boolean
  /** probe 失败时的具体错误（D-178 供员工「重验」时看到失败细节） */
  probeError?: string
  /** probe 失败时跟到的最终落地 URL（域名匹配判定依据，供员工核对） */
  probeFinalUrl?: string | null
}

interface CampaignForReplenish {
  id: bigint
  user_id: bigint
  user_merchant_id: bigint
  platform_connection_id: bigint | null
  target_country: string
  suffix_exchange_enabled: number
  suffix_needs_browser: number
  suffix_is_static: number
  is_deleted: number
  campaign_name: string | null
  status: string | null
  google_status: string | null
  google_campaign_id: string | null
  suffix_fail_count: number
  suffix_cooldown_until: Date | null
}

/**
 * 纯 HTTP 系列自适应目标库存：按该系列近 N 天真实消费速率定目标，替代「一律补到 20」。
 * 数据源：suffix_assignments.write_success=1 的 reported_at（Script 真正写进 Google Ads 才算消费，权威）。
 *   目标 = clamp( ceil(日均消费 × TARGET_COVERAGE_HOURS/24), MIN_TARGET_STOCK, TARGET_STOCK )
 * 高消费系列仍接近 20（不缺货），低/新系列降到下限（少蓄水、少 36h 过期作废）。
 * 查询失败 / 关闭时回退固定 TARGET_STOCK（不阻断补货）。
 */
async function computeAdaptiveTarget(campaignId: bigint): Promise<number> {
  if (!STOCK_CONFIG.ADAPTIVE_TARGET_ENABLED) return STOCK_CONFIG.TARGET_STOCK
  try {
    const since = new Date(Date.now() - STOCK_CONFIG.CONSUMPTION_LOOKBACK_DAYS * 24 * 3600_000)
    const consumed = await prisma.suffix_assignments.count({
      where: { campaign_id: campaignId, write_success: 1, reported_at: { gte: since }, is_deleted: 0 },
    })
    const dailyAvg = consumed / STOCK_CONFIG.CONSUMPTION_LOOKBACK_DAYS
    const desired = Math.ceil(dailyAvg * (STOCK_CONFIG.TARGET_COVERAGE_HOURS / 24))
    return Math.min(STOCK_CONFIG.TARGET_STOCK, Math.max(STOCK_CONFIG.MIN_TARGET_STOCK, desired))
  } catch (e) {
    console.warn('[stock-producer] computeAdaptiveTarget 失败，回退固定水位:', campaignId.toString(), e instanceof Error ? e.message : e)
    return STOCK_CONFIG.TARGET_STOCK
  }
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

  const campaign = (await prisma.campaigns.findFirst({
    where: { id: campaignId, is_deleted: 0 },
    select: {
      id: true,
      user_id: true,
      user_merchant_id: true,
      platform_connection_id: true,
      target_country: true,
      suffix_exchange_enabled: true,
      suffix_needs_browser: true,
      suffix_is_static: true,
      is_deleted: true,
      campaign_name: true,
      status: true,
      google_status: true,
      google_campaign_id: true,
      suffix_fail_count: true,
      suffix_cooldown_until: true,
    },
  })) as CampaignForReplenish | null

  if (!campaign) {
    return { campaignId: cid, skipped: true, reason: 'campaign_not_found', before: 0, generated: 0, after: 0, failed: 0 }
  }
  // D-177 落库冷却闸门：冷却期内不补货（proxy_unavailable 10min / 活链 30min / 疑似死链 8h）。
  // 落库使冷却跨 pm2 重启生效（旧进程内 Map 一天被 33 次重启清零，死链系列死循环重烧代理流量）。
  // force（lease NO_STOCK 按需路径）不受限——真没货时仍可立即尝试，成功即自动清冷却。
  if (!opts.force && campaign.suffix_cooldown_until && campaign.suffix_cooldown_until > new Date()) {
    return { campaignId: cid, skipped: true, reason: 'fail_cooldown', before: 0, generated: 0, after: 0, failed: 0 }
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

  // 「必须浏览器」系列（suffix_needs_browser=1，生成成功时自动学习）：
  // 每条后缀都要整页跑无头浏览器，代理流量是纯 HTTP 的几十倍——用更低的目标库存/水位少蓄水、少补货。
  // 调用方显式传 opts.target 时以显式值优先（lease 按需路径等）。
  const needsBrowser = campaign.suffix_needs_browser === 1
  // 纯 HTTP 系列：按真实消费速率自适应目标（治 32% 过期作废）。浏览器系列仍用低固定水位、
  // lease 等显式传 opts.target 的按需路径优先用显式值（force 补到位，不受自适应下调影响）。
  const defaultTarget = needsBrowser
    ? STOCK_CONFIG.BROWSER_TARGET_STOCK
    : await computeAdaptiveTarget(campaign.id)
  const target = Math.max(1, opts.target ?? defaultTarget)
  const lowWatermark = needsBrowser ? STOCK_CONFIG.BROWSER_LOW_WATERMARK : STOCK_CONFIG.LOW_WATERMARK

  const before = await prisma.suffix_pool.count({
    where: { campaign_id: campaignId, status: 'available', is_deleted: 0 },
  })

  let need = target - before
  if (!opts.force && before > lowWatermark) {
    return { campaignId: cid, skipped: true, reason: 'stock_sufficient', before, generated: 0, after: before, failed: 0 }
  }
  need = Math.min(Math.max(need, 0), STOCK_CONFIG.MAX_PER_REPLENISH)
  if (need <= 0) {
    return { campaignId: cid, skipped: true, reason: 'no_need', before, generated: 0, after: before, failed: 0 }
  }

  // 加载商家联盟链接 + 平台
  const merchant = await prisma.user_merchants.findFirst({
    where: { id: campaign.user_merchant_id, is_deleted: 0 },
    select: { id: true, platform: true, tracking_link: true, campaign_link: true, connection_campaign_links: true, platform_connection_id: true, merchant_name: true, merchant_url: true },
  })

  if (!merchant) {
    // 孤儿引用：user_merchant_id>0 但商家行已不存在（换平台账号后旧商家被同步清理，或尚未重新同步进库）。
    // 静默跳过、不报警——此类已在「换链接管理」列表显示为「未匹配商家」，并会由商家同步 + 自动关联修复；
    // 反复报 merchant_not_found 只会刷屏（user_merchant_id<=0 已在前置闸门拦下，这里专治 orphan）。
    return { campaignId: cid, skipped: true, reason: 'merchant_missing', before, generated: 0, after: before, failed: 0 }
  }
  // 账号感知：按广告归属账号(platform_connection_id)挑该号的链接。生成的 suffix 会应用到 live 广告，
  // 必须用广告自己账号的链接，否则真实转化会记到别的号（wj02 CG1/CG2 串号根治点）。
  // 归属账号没配链接 → 静默跳过（判定是否人工处理交给 merchant-link-health）。
  const affiliateUrl = pickCampaignAffiliateLink(campaign.platform_connection_id, merchant)
  if (!affiliateUrl) {
    // 商家在库但该账号缺联盟追踪链接：补货路径一律静默跳过、不再报警。
    // 「断链是否要人工处理」的判定统一交给 /api/cron/merchant-link-health：
    // 只有「该商家近 30 天有真实交易(affiliate_transactions)却仍断链」才升级为高优先告警，
    // 其余视为「仍在自愈流程中」（商家同步 / Google 回拉 / 手动填链接会修复），静默不刷屏。
    return { campaignId: cid, skipped: true, reason: 'merchant_no_tracking_link', before, generated: 0, after: before, failed: 0 }
  }
  // 落地无参数自愈兜底：pickCampaignAffiliateLink 优先返回「冻结的 campaign_link/账号链接」，
  // 而商家改版后该冻结链接的落地可能被 301 弹到无追踪参数的新站（FC-Moto/xcaret 类），
  // 商家动态 tracking_link 反而能跟出 per-click 参数。故记下 tracking_link 作兜底：
  // 当挑中链接 probe 命中 no_tracking 时，用 tracking_link 重试一次，成功即切换为本轮生效链接。
  const trackingFallback = merchant.tracking_link?.trim() || ''

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
  // 与现有库存/本轮已产出内容完全相同而被去重的条数。
  // 全是重复 = 该商家落地页参数不随会话变化（静态后缀，无 per-click token），
  // 库存天然无法超过「不同内容数」，不是补货故障。
  let duplicates = 0
  const failures: GenFailure[] = []

  const persist = async (suffix: string, exitIp: string | null): Promise<boolean> => {
    if (existingSuffixes.has(suffix)) {
      duplicates++
      return false
    }
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

  // 本轮实际生效链接：默认账号挑中链接，probe 命中 no_tracking 且存在不同的 tracking_link 时切换。
  let effectiveUrl = affiliateUrl

  // ── probe：先探一条 ──
  let probe = await generateOneSuffix(effectiveUrl, country, platform, { userId: campaign.user_id, campaignId, referer: refererUrl })
  if (!probe.ok && probe.reason === 'no_tracking' && trackingFallback && trackingFallback !== effectiveUrl) {
    // 挑中链接落地无追踪参数：改用商家动态 tracking_link 重试一次。
    const retry = await generateOneSuffix(trackingFallback, country, platform, { userId: campaign.user_id, campaignId, referer: refererUrl })
    if (retry.ok) {
      effectiveUrl = trackingFallback
      probe = retry
    }
  }
  if (!probe.ok) {
    failed++
    const reason = await handleProbeFailure(campaign, merchant.merchant_name, merchant.merchant_url, effectiveUrl, probe)
    return { campaignId: cid, skipped: false, reason, before, generated: 0, after: before, failed, probeError: probe.error, probeFinalUrl: probe.finalUrl ?? null }
  }
  // probe 成功 = 链接确认活着：清 D-177 疑似死链计数与冷却（仅有残留时写库）
  if (campaign.suffix_fail_count > 0 || campaign.suffix_cooldown_until) {
    await setFailCooldown(campaign, 0, null)
  }
  // 学习「必须浏览器」标记：probe 成功即知本系列纯 HTTP 能否跟到（usedBrowser）。
  // 双向回写——变为需要 → 置 1（下轮起低频补货）；恢复纯 HTTP 可跟 → 清 0（恢复正常水位）。仅变化时写库。
  const observedNeedsBrowser = probe.usedBrowser ? 1 : 0
  if (observedNeedsBrowser !== campaign.suffix_needs_browser) {
    try {
      await prisma.campaigns.update({
        where: { id: campaignId },
        data: { suffix_needs_browser: observedNeedsBrowser },
      })
    } catch (e) {
      console.warn('[stock-producer] 更新 suffix_needs_browser 失败:', cid, e instanceof Error ? e.message : e)
    }
  }
  if (await persist(probe.suffix, probe.exitIp)) generated++

  // ── batch：成功后批量生成剩余（用本轮生效链接） ──
  const remaining = need - 1
  if (remaining > 0) {
    let consecutiveFail = 0
    let circuitOpen = false
    await runWithConcurrency(remaining, STOCK_CONFIG.CONCURRENCY, async () => {
      if (circuitOpen) return
      const r = await generateOneSuffix(effectiveUrl, country, platform, { userId: campaign.user_id, campaignId, referer: refererUrl })
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

  if (generated === 0 && duplicates > 0) {
    // 静态后缀商家：产出内容与库存完全重复（xcaret 类，落地页无 per-click 参数）。
    // 只要出现过重复即证明内容静态、库存无法超过不同内容数，本轮零星代理失败不改变结论。
    // 不是故障——现有库存即是全部可能内容，消费后 lease 会触发按需重生成。
    // 清掉此前误报的告警，并交由调用方长冷却，停止每轮空烧 20 次生成。
    await resolveAlertsByType(campaign.user_id, campaignId, ['low_stock', 'replenish_failed', 'invalid_link', 'merchant_not_found'])
    // 学习「静态后缀」标记：写回 campaigns，前端库存列据此不再按低水位误标红（1⚠）。
    await setStaticFlag(campaign, 1)
    return { campaignId: cid, skipped: false, reason: 'static_suffix', before, generated: 0, after: before, failed: 0, needsBrowser: probe.usedBrowser }
  }

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
        affiliateUrl: effectiveUrl.slice(0, 300),
        reason: sample?.reason,
      },
    })
  } else {
    // 有产出：解决该系列旧的库存类告警
    await resolveAlertsByType(campaign.user_id, campaignId, ['low_stock', 'replenish_failed', 'invalid_link', 'merchant_not_found'])
    // 双向学习「静态后缀」：批量产出全为新内容（零重复）说明落地参数随会话变化（商家换了带 token 的链接），清 0 恢复正常水位口径。
    // need=1 的单条按需生成无法判定静态性（静态商家消费后重生成同样是 1 条新内容），不作依据。
    if (duplicates === 0 && need > 1) await setStaticFlag(campaign, 0)
    // 若产出仍明显不足目标水位，记一条 low_stock（warning）。
    // 用 after < target（而非 <= lowWatermark）：自适应后低消费系列目标可能就等于低水位，
    // 补到目标即达标，不该再报 low_stock 刷屏。仅当产出连目标都没够到才告警。
    // 例外：缺口是「内容重复」造成的（静态后缀商家补 1 条后其余全是重复）——
    // 库存不可能超过不同内容数，报 low_stock 只会每轮刷屏。
    if (after < target && after <= lowWatermark && duplicates === 0) {
      await raiseAlert(campaign.user_id, {
        type: 'low_stock',
        campaignId,
        level: 'warning',
        message: `广告系列「${campaign.campaign_name ?? cid}」库存偏低（当前 ${after}，目标 ${target}），补货产出不足`,
        context: { campaignName: campaign.campaign_name, country, generated, failed },
      })
    }
  }

  return { campaignId: cid, skipped: false, before, generated, after, failed, needsBrowser: probe.usedBrowser }
}

/** 「静态后缀」标记回写（仅变化时写库，失败不阻断补货主流程） */
async function setStaticFlag(campaign: CampaignForReplenish, value: 0 | 1): Promise<void> {
  if (campaign.suffix_is_static === value) return
  try {
    await prisma.campaigns.update({ where: { id: campaign.id }, data: { suffix_is_static: value } })
    campaign.suffix_is_static = value
  } catch (e) {
    console.warn('[stock-producer] 更新 suffix_is_static 失败:', campaign.id.toString(), e instanceof Error ? e.message : e)
  }
}

/** D-177 疑似死链计数/冷却回写（仅变化时写库，失败不阻断补货主流程） */
async function setFailCooldown(
  campaign: CampaignForReplenish,
  failCount: number,
  cooldownUntil: Date | null,
): Promise<void> {
  try {
    await prisma.campaigns.update({
      where: { id: campaign.id },
      data: { suffix_fail_count: failCount, suffix_cooldown_until: cooldownUntil },
    })
    campaign.suffix_fail_count = failCount
    campaign.suffix_cooldown_until = cooldownUntil
  } catch (e) {
    console.warn('[stock-producer] 更新失败冷却字段失败:', campaign.id.toString(), e instanceof Error ? e.message : e)
  }
}

/**
 * D-177 probe 失败三态分类（采纳 kyads verify-link 判定思想），返回 ReplenishResult.reason：
 *
 * 1) proxy_unavailable —— kookeey 余额耗尽/熔断/池空，resolver 未发起真实跟链。环境故障，
 *    短冷却(10min)重试，不计死链、不告警（D-176 事故：此类被误判成 3316 次 no_tracking 假死）。
 * 2) alive_no_tracking —— 跟链落地根域名 == 商家官网根域名，只是没拿到追踪参数：链接活着
 *    （需浏览器执行 JS / 参数被吃），冷却 30min 换出口重试，不报 invalid_link，并清疑似死链计数。
 * 3) probe_failed —— 其余硬失败（域名也不匹配 / 停跳板 / 超时等）：疑似死链计数 +1，
 *    达 DEAD_LINK_FAIL_THRESHOLD 才升级 invalid_link 告警 + 长冷却(8h)；未达阈值先短冷却(30min)。
 *    连续达标才告警，避免把代理抖动/慢站误报成死链刷屏。
 */
async function handleProbeFailure(
  campaign: CampaignForReplenish,
  merchantName: string | null,
  merchantUrl: string | null,
  affiliateUrl: string,
  fail: GenFailure,
): Promise<string> {
  const cid = campaign.id.toString()

  // 1) 代理不可用：不下链接死活结论
  if (fail.reason === 'proxy_unavailable') {
    await setFailCooldown(campaign, campaign.suffix_fail_count, new Date(Date.now() + STOCK_CONFIG.PROXY_UNAVAILABLE_COOLDOWN_MS))
    return 'proxy_unavailable'
  }

  // 2) 域名匹配 = 活链（kyads matched 判定）：落到了商家官网、只是无追踪参数
  if (fail.reason === 'no_tracking' && sameRootDomain(fail.finalUrl, merchantUrl)) {
    await setFailCooldown(campaign, 0, new Date(Date.now() + STOCK_CONFIG.ALIVE_LINK_COOLDOWN_MS))
    // 链接确认活着：顺手清掉此前误报的 invalid_link
    await resolveAlertsByType(campaign.user_id, campaign.id, ['invalid_link'])
    return 'alive_no_tracking'
  }

  // 3) 疑似死链：连续计数，达阈值才告警 + 长冷却
  const failCount = campaign.suffix_fail_count + 1
  const isDead = failCount >= STOCK_CONFIG.DEAD_LINK_FAIL_THRESHOLD
  const cooldownMs = isDead ? STOCK_CONFIG.DEAD_LINK_COOLDOWN_MS : STOCK_CONFIG.ALIVE_LINK_COOLDOWN_MS
  await setFailCooldown(campaign, failCount, new Date(Date.now() + cooldownMs))

  if (isDead) {
    await raiseAlert(campaign.user_id, {
      type: 'invalid_link',
      campaignId: campaign.id,
      level: 'error',
      message: `广告系列「${campaign.campaign_name ?? cid}」联盟链接疑似失效（连续 ${failCount} 次跟链失败）：${fail.error}`,
      context: {
        campaignName: campaign.campaign_name,
        merchantName,
        country: campaign.target_country,
        affiliateUrl: affiliateUrl.slice(0, 300),
        reason: fail.reason,
        finalUrl: fail.finalUrl ?? null,
        failCount,
      },
    })
  }
  return 'probe_failed'
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
  //    + 不在 D-177 落库失败冷却期内（proxy_unavailable/活链/疑似死链冷却，pm2 重启不丢）
  const enabled = await prisma.campaigns.findMany({
    where: {
      status: 'active',
      google_status: 'ENABLED',
      google_campaign_id: { not: null },
      suffix_exchange_enabled: 1,
      is_deleted: 0,
      user_merchant_id: { not: BigInt(0) },
      OR: [{ suffix_cooldown_until: null }, { suffix_cooldown_until: { lt: new Date() } }],
      ...(disabledUserIds.length > 0 ? { user_id: { notIn: disabledUserIds } } : {}),
    },
    select: { id: true, suffix_needs_browser: true },
  })
  if (enabled.length === 0) return { scanned: 0, lowStock: 0, replenished: 0, results: [] }
  const ids = enabled.map((c) => c.id)
  const browserCampaignIds = new Set(
    enabled.filter((c) => c.suffix_needs_browser === 1).map((c) => c.id.toString()),
  )

  // 2. 一次 groupBy 取每系列当前可用库存（避免 N 次 count）
  const stockRows = await prisma.suffix_pool.groupBy({
    by: ['campaign_id'],
    where: { campaign_id: { in: ids }, status: 'available', is_deleted: 0 },
    _count: { _all: true },
  })
  const stockMap = new Map(stockRows.map((r) => [r.campaign_id.toString(), r._count._all]))

  // 3. 低于低水位的（含 0 库存 / 无记录），按库存升序，最紧急优先，限额保护。
  //    「必须浏览器」系列用更低的专用水位（少进队）；
  //    跳过仍在失败冷却/浏览器补货冷却期内的系列（常败系列不再每轮霸占预算，让位给健康系列）。
  const now = Date.now()
  const lowAll = ids
    .map((id) => ({ id, stock: stockMap.get(id.toString()) ?? 0 }))
    .filter((x) => {
      const watermark = browserCampaignIds.has(x.id.toString())
        ? STOCK_CONFIG.BROWSER_LOW_WATERMARK
        : STOCK_CONFIG.LOW_WATERMARK
      return x.stock <= watermark
    })
    .sort((a, b) => a.stock - b.stock)

  const low = lowAll.filter((x) => {
    const key = x.id.toString()
    if ((failCooldown.get(key) ?? 0) > now) return false
    if ((browserCooldown.get(key) ?? 0) > now) return false
    return true
  })
  // 清理已过期的冷却项，避免 Map 无限增长
  for (const [k, until] of failCooldown) if (until <= now) failCooldown.delete(k)
  for (const [k, until] of browserCooldown) if (until <= now) browserCooldown.delete(k)

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
    // 「必须浏览器」系列：本轮处理过（无论成败）即进入浏览器补货冷却，压低整页浏览器跑动频率。
    // r.needsBrowser 覆盖本轮 probe 首次学到「必须浏览器」的系列（进队时还不在 browserCampaignIds 里）。
    if (browserCampaignIds.has(key) || r.needsBrowser === true) {
      browserCooldown.set(key, Date.now() + STOCK_CONFIG.BROWSER_REPLENISH_COOLDOWN_MS)
    }
    if ((r.generated ?? 0) > 0) {
      replenished++
      failCooldown.delete(key) // 成功产出：清除冷却
    } else if (r.reason === 'merchant_missing' || r.reason === 'merchant_no_tracking_link' || r.reason === 'merchant_not_linked') {
      // 商家断链（孤儿 / 缺链接 / 未关联）：长冷却，避免每轮重复扫描；
      // 是否需人工处理由 /api/cron/merchant-link-health 按「有无交易」分流判定。
      failCooldown.set(key, Date.now() + MERCHANT_COOLDOWN_MS)
    } else if (r.reason === 'static_suffix') {
      // 静态后缀商家：内容不随会话变化，cron 补货无意义（消费后由 lease 触发按需重生成）。
      // 长冷却让出预算；属数据特征而非故障，随时可被 lease force 路径绕过。
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
 *   1b) available 但 expires_at 为空（过期机制生效前入库的历史行）且入库已超 EXPIRE_HOURS
 *       → expired。否则这类行永远逃逸回收，而 lease 又把「空 expires_at」视为有效并 orderBy
 *       created_at asc 优先派发——等于把 15 天前的死 clickid 优先塞到 live 广告，换链形同虚设。
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
  // 1b) 兜底回收「expires_at 为空」的历史陈旧行（EXPIRE_HOURS>0 时才启用；=0 表示全局不过期）。
  if (STOCK_CONFIG.EXPIRE_HOURS > 0) {
    try {
      const legacyCutoff = new Date(now.getTime() - STOCK_CONFIG.EXPIRE_HOURS * 3600_000)
      const r1b = await prisma.suffix_pool.updateMany({
        where: { status: 'available', is_deleted: 0, expires_at: null, created_at: { lt: legacyCutoff } },
        data: { status: 'expired' },
      })
      if (r1b.count > 0) {
        expiredAvailable += r1b.count
        console.log(`[stock-producer] recycle 回收无 expires_at 的历史陈旧库存 ${r1b.count} 条`)
      }
    } catch (e) {
      console.warn('[stock-producer] recycle 空 expiry 历史行失败:', e instanceof Error ? e.message : e)
    }
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