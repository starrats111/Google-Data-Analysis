/**
 * D-242 link_forbidden 自愈：自动重取联盟追踪链接
 *
 * 背景：追踪链接 token 被联盟单条作废（跳板 4xx）时，此前唯一出路是人工到联盟后台
 * 重新取链再点「换链接」。但链接本来就来自联盟 API（fetchAllMerchants → campaign_link），
 * 系统有凭据、有通道，完全可以自己重取——jym #155204 的 link_forbidden 挂了 409 次
 * 没人处理就是代价。
 *
 * 与日常商家同步的关系：daily-merchant-check 刻意**不覆盖**已有 tracking_link
 * （防止把活链接换成新 token 引入无谓变动），所以死链不会被日常同步救活。
 * 本模块是唯一一条「定向覆盖」通道，且只对挂着 open link_forbidden 告警的系列生效。
 *
 * 护栏：
 * - 每小时至多一轮、模块级并发锁（由 suffix-replenish cron 触发，fire-and-forget）
 * - 每轮最多处理 2 个联盟账号（无单商家查询 API，只能全量拉列表，LH/RW 单账号要数分钟）
 * - 每系列尝试上限 3 次、两次间隔 ≥6h，状态存告警 context（heal* 键，raiseAlert 已改为合并 context）
 * - 新链接必须先 GET 验证非 4xx 才写库；API 查不到 MID / 链接与旧链相同 / 新链仍 4xx → 计一次尝试转人工
 */

import { prisma } from '@/lib/prisma'
import { Prisma } from '@/generated/prisma/client'
import { fetchAllMerchants } from '@/lib/platform-api'
import { pickCampaignAffiliateLink, loadConnectionAliasMap } from '@/lib/merchant-connection'
import { normalizePlatformCode } from '@/lib/constants'
import { triggerReplenishAsync } from '@/lib/suffix-engine/stock-producer'

/** 每系列自愈尝试上限：3 次都换不活（API 不给新链/新链也死）就别再烧 API 了，等人工 */
const HEAL_MAX_ATTEMPTS = 3
/** 两次尝试的最小间隔：联盟侧的 token 状态不会分钟级变化，6h 足够 */
const HEAL_RETRY_INTERVAL_MS = 6 * 3600_000
/** 每轮最多处理的联盟账号数：一个账号 = 一次全量商家拉取（LH 80+ 页、每页限频 1.5s） */
const MAX_CONNS_PER_ROUND = 2

let isHealing = false

interface HealState {
  healAttempts: number
  healLastAt: number
  healLastResult: string
}

function readHealState(context: unknown): HealState {
  const c = context && typeof context === 'object' && !Array.isArray(context) ? (context as Record<string, unknown>) : {}
  return {
    healAttempts: typeof c.healAttempts === 'number' ? c.healAttempts : 0,
    healLastAt: typeof c.healLastAt === 'number' ? c.healLastAt : 0,
    healLastResult: typeof c.healLastResult === 'string' ? c.healLastResult : '',
  }
}

/** 把本次尝试结论合并写回告警 context（raiseAlert 的重报只会合并、不会清掉这些键） */
async function recordAttempt(alertId: bigint, prevContext: unknown, prev: HealState, result: string): Promise<void> {
  const base =
    prevContext && typeof prevContext === 'object' && !Array.isArray(prevContext)
      ? (prevContext as Record<string, unknown>)
      : {}
  await prisma.suffix_alerts
    .update({
      where: { id: alertId },
      data: {
        context: {
          ...base,
          healAttempts: prev.healAttempts + 1,
          healLastAt: Date.now(),
          healLastResult: result,
        } as Prisma.InputJsonValue,
      },
    })
    .catch(() => {})
}

/**
 * 轻量验证新链接：跳板对死 token 直接回 4xx（jym 案例即 403），对活 token 回 200/302。
 * 只看首跳响应码，不跟整条链——完整验证交给写库后的 force 补货 probe。
 */
async function quickCheckLink(url: string): Promise<{ ok: boolean; status: number }> {
  try {
    const ctrl = new AbortController()
    const timer = setTimeout(() => ctrl.abort(), 20_000)
    const res = await fetch(url, {
      redirect: 'manual',
      signal: ctrl.signal,
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36' },
    })
    clearTimeout(timer)
    return { ok: res.status < 400, status: res.status }
  } catch {
    // 网络抖动不算「新链也死」：不写库也不消耗结论，下一轮重试
    return { ok: false, status: 0 }
  }
}

export interface HealRoundResult {
  scanned: number
  eligible: number
  connsProcessed: number
  replaced: number
  skipped: string[]
}

/**
 * 一轮自愈。由 suffix-replenish cron 每小时触发一次（fire-and-forget）。
 */
export async function healForbiddenLinks(): Promise<HealRoundResult> {
  const res: HealRoundResult = { scanned: 0, eligible: 0, connsProcessed: 0, replaced: 0, skipped: [] }
  if (isHealing) return res
  isHealing = true
  try {
    return await healRound(res)
  } finally {
    isHealing = false
  }
}

async function healRound(res: HealRoundResult): Promise<HealRoundResult> {
  // 只救「在投且换链启用中」的系列：link_forbidden 本就只对 active+ENABLED 报，
  // 这里再校验一遍是防止告警挂着期间系列被暂停。
  const alerts = await prisma.suffix_alerts.findMany({
    where: { type: 'link_forbidden', status: 'open', is_deleted: 0, campaign_id: { not: null } },
    select: { id: true, user_id: true, campaign_id: true, context: true },
    orderBy: { last_seen_at: 'desc' },
    take: 100,
  })
  res.scanned = alerts.length
  if (alerts.length === 0) return res

  const now = Date.now()
  type Job = {
    alertId: bigint
    context: unknown
    state: HealState
    userId: bigint
    campaignId: bigint
  }
  const jobs: Job[] = []
  for (const a of alerts) {
    const state = readHealState(a.context)
    if (state.healAttempts >= HEAL_MAX_ATTEMPTS) continue
    if (now - state.healLastAt < HEAL_RETRY_INTERVAL_MS) continue
    jobs.push({ alertId: a.id, context: a.context, state, userId: a.user_id, campaignId: a.campaign_id! })
  }
  if (jobs.length === 0) return res

  const campaigns = await prisma.campaigns.findMany({
    where: {
      id: { in: jobs.map((j) => j.campaignId) },
      status: 'active',
      google_status: 'ENABLED',
      is_deleted: 0,
    },
    select: { id: true, user_id: true, campaign_name: true, user_merchant_id: true, platform_connection_id: true },
  })
  const campaignById = new Map(campaigns.map((c) => [c.id.toString(), c]))

  // 按联盟账号分组：一个账号只全量拉一次商家列表，救下面所有告警系列
  const byConn = new Map<string, Job[]>()
  for (const j of jobs) {
    const c = campaignById.get(j.campaignId.toString())
    if (!c) continue // 已暂停/已删，告警会被 resolveAlertsForInactiveCampaigns 收敛，不占尝试次数
    if (!c.platform_connection_id || !c.user_merchant_id || c.user_merchant_id <= BigInt(0)) {
      await recordAttempt(j.alertId, j.context, j.state, 'no_connection_or_merchant')
      continue
    }
    res.eligible++
    const key = c.platform_connection_id.toString()
    const list = byConn.get(key)
    if (list) list.push(j)
    else byConn.set(key, [j])
  }

  let connsDone = 0
  for (const [connKey, connJobs] of byConn) {
    if (connsDone >= MAX_CONNS_PER_ROUND) {
      res.skipped.push(`conn ${connKey}: 本轮账号配额已用完，下轮再处理`)
      continue
    }
    const conn = await prisma.platform_connections.findFirst({
      where: { id: BigInt(connKey), is_deleted: 0 },
      select: { id: true, user_id: true, platform: true, api_key: true, account_name: true },
    })
    if (!conn?.api_key || conn.api_key.length <= 5) {
      for (const j of connJobs) await recordAttempt(j.alertId, j.context, j.state, 'no_api_key')
      continue
    }
    connsDone++
    res.connsProcessed++

    const platform = normalizePlatformCode(conn.platform)
    console.log(`[link-heal] 拉取 ${platform}(conn ${connKey}) 商家列表，待救系列 ${connJobs.length} 个`)
    const fetched = await fetchAllMerchants(platform, conn.api_key)
    if (fetched.error && fetched.merchants.length === 0) {
      // API 整体失败（配额/网络）不消耗系列的尝试次数，下一轮重来
      console.warn(`[link-heal] ${platform} API 失败：${fetched.error}`)
      res.skipped.push(`conn ${connKey}: API 失败 ${fetched.error}`)
      continue
    }
    const linkByMid = new Map<string, string>()
    for (const m of fetched.merchants) {
      if (m.merchant_id && m.campaign_link) linkByMid.set(String(m.merchant_id), m.campaign_link)
    }

    const aliasMap = await loadConnectionAliasMap(conn.user_id)
    for (const j of connJobs) {
      const c = campaignById.get(j.campaignId.toString())!
      const merchant = await prisma.user_merchants.findFirst({
        where: { id: c.user_merchant_id!, is_deleted: 0 },
        select: {
          id: true,
          merchant_id: true,
          merchant_name: true,
          tracking_link: true,
          campaign_link: true,
          connection_campaign_links: true,
          platform_connection_id: true,
        },
      })
      if (!merchant) {
        await recordAttempt(j.alertId, j.context, j.state, 'merchant_row_missing')
        continue
      }

      const newLink = (linkByMid.get(merchant.merchant_id) ?? '').trim()
      if (!newLink) {
        // 联盟目录里已经没有这个商家/不给链接：不臆造数据，转人工
        await recordAttempt(j.alertId, j.context, j.state, 'not_in_platform_api')
        console.log(`[link-heal] ${c.campaign_name}: 联盟 API 未返回商家 ${merchant.merchant_id} 的链接，转人工`)
        continue
      }

      const oldLink = pickCampaignAffiliateLink(c.platform_connection_id, merchant, aliasMap)
      if (newLink === oldLink) {
        // 联盟 API 还在发同一条死链：重取无意义，转人工（可能要在联盟后台重新生成）
        await recordAttempt(j.alertId, j.context, j.state, 'api_returns_same_dead_link')
        console.log(`[link-heal] ${c.campaign_name}: API 返回的仍是同一条链接，转人工`)
        continue
      }

      const check = await quickCheckLink(newLink)
      if (check.status === 0) {
        res.skipped.push(`campaign ${c.id}: 新链接验证网络失败，下轮重试`)
        continue // 不计尝试
      }
      if (!check.ok) {
        await recordAttempt(j.alertId, j.context, j.state, `new_link_http_${check.status}`)
        console.log(`[link-heal] ${c.campaign_name}: 新链接同样被拒（HTTP ${check.status}），转人工`)
        continue
      }

      await applyNewLink(c, merchant, connKey, newLink)
      await recordAttempt(j.alertId, j.context, j.state, 'replaced')
      res.replaced++
      console.log(`[link-heal] ${c.campaign_name}: 已自动换上新链接（HTTP ${check.status}），触发补货验证`)
    }
  }
  return res
}

/**
 * 写库口径与手动 updateLink（link-exchange/action）完全一致：
 * per-conn 槽位始终写；仅当归属账号 = 商家主连接（或未记录主连接）时才动主链接；
 * 清链接校验状态与该系列的失败计数/冷却/needs_v2；刷新在跑补刷任务的链接快照；触发 force 补货。
 */
async function applyNewLink(
  campaign: { id: bigint; user_id: bigint },
  merchant: {
    id: bigint
    connection_campaign_links: unknown
    platform_connection_id: bigint | null
  },
  connKey: string,
  newLink: string,
): Promise<void> {
  const raw = merchant.connection_campaign_links
  const obj: Record<string, string> = raw && typeof raw === 'object' && !Array.isArray(raw) ? { ...(raw as Record<string, string>) } : {}
  obj[connKey] = newLink
  const mainConnKey = merchant.platform_connection_id?.toString() ?? null
  const touchPrimary = !mainConnKey || mainConnKey === connKey

  await prisma.user_merchants.update({
    where: { id: merchant.id },
    data: {
      ...(touchPrimary ? { tracking_link: newLink, campaign_link: null } : {}),
      connection_campaign_links: obj as Prisma.InputJsonValue,
      tracking_status: 'unchecked',
      link_status: 'unchecked',
      parent_network: null,
      parent_blacklisted: 0,
      parent_checked_at: null,
      parent_check_reason: null,
    },
  })

  // 旧链接的失败历史对新链接无意义（同 updateLink 的 D-178/D-201/D-203 口径）
  await prisma.campaigns.update({
    where: { id: campaign.id },
    data: { suffix_fail_count: 0, suffix_cooldown_until: null, suffix_no_tracking_streak: 0, suffix_needs_v2: 0 },
  })

  // 在跑补刷任务用的是 affiliate_url 快照，不刷新会继续拿死链去点
  await prisma.kyads_click_tasks.updateMany({
    where: { campaign_id: campaign.id, status: { in: ['pending', 'running'] }, is_deleted: 0 },
    data: { affiliate_url: newLink.slice(0, 1024) },
  })

  // force 补货：probe 成功即自动 resolve link_forbidden/invalid_link 等告警（既有闭环）
  triggerReplenishAsync(campaign.id, { force: true, manual: true })
}
