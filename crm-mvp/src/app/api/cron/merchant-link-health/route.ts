/**
 * GET /api/cron/merchant-link-health — 换链接「断链商家」健康巡检（按有无交易数据分流）
 *
 * 背景（需求口径）：
 *   广告系列的联盟链接断裂有多种自愈中的中间态——未关联(user_merchant_id=0)、
 *   换平台账号后旧商家被同步清理导致的孤儿引用、商家在库但还没拿到 tracking_link 等。
 *   这些只要「商家同步 / 手动填链接」流程跑起来，多数会自愈，不应反复刷「商家库找不到」。
 *   注：曾有「Google 回拉」自动兜底（final_url+final_url_suffix 拼链接回填），2026-07 起废弃——
 *   拼出来的是落地页+冻结令牌（静态后缀），对换链无价值且会覆盖人工填的真实平台链接，改为一律人工补链。
 *
 * 分流规则（唯一权威判定点；补货 / lease 路径已全部静默）：
 *   - 断链系列若关联商家「近 N 天有真实交易(affiliate_transactions)」→ 这是正在赚钱却断链的真问题，
 *     写一条高优先 merchant_not_found 告警（level=error，context.hasRevenue=true），让人工补链接。
 *   - 断链系列若无任何交易 → 视为「自愈流程中」，解决该系列遗留的 merchant_not_found 噪音告警，静默。
 *   - 已自愈（不再断链）的系列 → 一并解决其遗留 merchant_not_found 告警。
 *   - 「有交易却断链」的高优先告警若被人工点掉(resolved)，且点掉之后没有新的佣金回流 →
 *     视为「确实没佣金、人工已确认」，尊重人工判断、不再重复刷告警；
 *     一旦点掉之后又出现新交易（说明确实是在赚钱却断链），才会重新升级告警。
 *
 * 返回观察统计，便于「先观察」阶段评估真问题规模。
 *
 * 鉴权：CRON_SECRET（Authorization: Bearer ...）
 * crontab 示例（每 30 分钟）：
 *   星/30 * * * * curl -s -H 'Authorization: Bearer ${CRON_SECRET}' 'http://localhost:20050/api/cron/merchant-link-health' >> /var/log/cron-merchant-link-health.log 2>&1
 */

import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { raiseAlert, resolveAlertsByType } from '@/lib/suffix-engine/alerts'
import { parseCampaignNameFull } from '@/lib/campaign-merchant-link'

export const dynamic = 'force-dynamic'
export const maxDuration = 300

/** 「有交易」的回看窗口（天）。可调：默认近 30 天有任意 affiliate_transactions 记录即视为有数据。 */
const REVENUE_LOOKBACK_DAYS = 30

let isRunning = false

function verifyCron(req: NextRequest): boolean {
  const secret = process.env.CRON_SECRET
  if (!secret) return false
  return req.headers.get('authorization') === `Bearer ${secret}`
}

interface UserHealth {
  brokenTotal: number
  withRevenue: number // 有交易→已升级高优先告警
  selfHealing: number // 无交易→静默/清噪音
  dismissed: number // 有交易断链，但人工已点掉告警且之后无新佣金回流 → 尊重人工判断、静默不再刷
}

async function checkUser(userId: bigint): Promise<UserHealth> {
  const health: UserHealth = { brokenTotal: 0, withRevenue: 0, selfHealing: 0, dismissed: 0 }

  // 1. 该用户「已启用」广告系列（与告警可见性口径一致）
  const campaigns = await prisma.campaigns.findMany({
    where: {
      user_id: userId,
      status: 'active',
      google_status: 'ENABLED',
      is_deleted: 0,
      google_campaign_id: { not: null },
    },
    select: {
      id: true,
      campaign_name: true,
      user_merchant_id: true,
      google_campaign_id: true,
      customer_id: true,
      mcc_id: true,
      target_country: true,
    },
  })
  if (campaigns.length === 0) return health

  // 2. 解析仍存活的被引用商家（有可用联盟链接才算「不断链」）
  const refIds = campaigns
    .map((c) => c.user_merchant_id)
    .filter((id): id is bigint => !!id && id > BigInt(0))
  const aliveMerchants =
    refIds.length > 0
      ? await prisma.user_merchants.findMany({
          where: { id: { in: refIds }, user_id: userId, is_deleted: 0 },
          select: { id: true, tracking_link: true, campaign_link: true },
        })
      : []
  // id → 是否有可用链接
  const aliveLinkOk = new Map<string, boolean>()
  for (const m of aliveMerchants) {
    const hasLink = !!(m.tracking_link?.trim() || m.campaign_link?.trim())
    aliveLinkOk.set(m.id.toString(), hasLink)
  }

  // 3. 近 N 天「有交易」的商家维度集合 + 最新交易时间（两条 groupBy 查询，避免按 user_merchant_id 全表扫）
  //    最新交易时间用于「人工点掉后是否又有新佣金回流」的判定。
  const cutoff = new Date(Date.now() - REVENUE_LOOKBACK_DAYS * 24 * 3600_000)
  const [byMerchantId, byPlatformMid] = await Promise.all([
    prisma.affiliate_transactions.groupBy({
      by: ['user_merchant_id'],
      where: { user_id: userId, is_deleted: 0, transaction_time: { gte: cutoff } },
      _max: { transaction_time: true },
    }),
    prisma.affiliate_transactions.groupBy({
      by: ['platform', 'merchant_id'],
      where: { user_id: userId, is_deleted: 0, transaction_time: { gte: cutoff } },
      _max: { transaction_time: true },
    }),
  ])
  const revenueMaxByMerchant = new Map<string, Date>()
  for (const r of byMerchantId) {
    if (r._max.transaction_time) revenueMaxByMerchant.set(r.user_merchant_id.toString(), r._max.transaction_time)
  }
  const revenueMaxByPlatformMid = new Map<string, Date>()
  for (const r of byPlatformMid) {
    if (r._max.transaction_time) revenueMaxByPlatformMid.set(`${r.platform}:${r.merchant_id}`, r._max.transaction_time)
  }

  // 3b. 该用户「已被人工点掉(resolved)」的 merchant_not_found 告警 → campaign_id → 最近一次解决时间。
  //     用于：人工点掉后只要之后没有新的佣金回流，本巡检就尊重人工判断、不再重新冒告警。
  const dismissedRows = await prisma.suffix_alerts.findMany({
    where: {
      user_id: userId,
      type: 'merchant_not_found',
      status: 'resolved',
      is_deleted: 0,
      campaign_id: { in: campaigns.map((c) => c.id) },
    },
    select: { campaign_id: true, resolved_at: true },
  })
  const dismissedByCampaign = new Map<string, Date>()
  for (const d of dismissedRows) {
    if (!d.campaign_id || !d.resolved_at) continue
    const k = d.campaign_id.toString()
    const prev = dismissedByCampaign.get(k)
    if (!prev || d.resolved_at > prev) dismissedByCampaign.set(k, d.resolved_at)
  }

  // 4. 逐系列判定断链 + 分流
  for (const c of campaigns) {
    const mid = c.user_merchant_id
    const isUnmatched = !mid || mid <= BigInt(0)
    const isOrphan = !isUnmatched && !aliveLinkOk.has(mid.toString())
    const isNoLink = !isUnmatched && aliveLinkOk.get(mid.toString()) === false
    const broken = isUnmatched || isOrphan || isNoLink

    if (!broken) {
      // 已自愈：清掉该系列遗留的 merchant_not_found 告警
      await resolveAlertsByType(userId, c.id, ['merchant_not_found'])
      continue
    }

    health.brokenTotal++

    // 是否有真实交易 + 最新交易时间：优先按 user_merchant_id 命中（孤儿也能命中，因交易行仍带旧 id）；
    // 未关联(=0) 或未命中时，回退按「系列名解析的 平台:MID」命中交易商家维度。
    let latestTxn: Date | null = null
    if (!isUnmatched) latestTxn = revenueMaxByMerchant.get(mid.toString()) ?? null
    const parsed = parseCampaignNameFull(c.campaign_name || '')
    if (parsed) {
      const t = revenueMaxByPlatformMid.get(`${parsed.platform}:${parsed.mid}`)
      if (t && (!latestTxn || t > latestTxn)) latestTxn = t
    }
    const hasRevenue = latestTxn !== null

    if (hasRevenue) {
      // 人工已点掉(resolved) 且 之后没有新的佣金回流 → 真的可能就是没佣金，尊重人工判断：
      // 静默跳过（既不重新刷告警，也不耗 Google 回拉配额）。一旦点掉之后又来新交易，才重新升级告警。
      const dismissedAt = dismissedByCampaign.get(c.id.toString())
      if (dismissedAt && latestTxn && dismissedAt >= latestTxn) {
        health.dismissed++
        continue
      }

      health.withRevenue++
      const reason = isUnmatched ? '未匹配商家' : isOrphan ? '关联商家已不在商家库（孤儿）' : '商家缺联盟追踪链接'

      // 不再做 Google 自动回拉：final_url + final_url_suffix 拼出来的是「落地页 + 冻结令牌」，
      // 每次生成的后缀内容相同（静态后缀），对换链无价值，还会覆盖人工填的平台真实追踪链接。
      // 断链一律升级高优先告警，要求人工到商家库填平台原始追踪链接。
      await raiseAlert(userId, {
        type: 'merchant_not_found',
        campaignId: c.id,
        level: 'error',
        message: `广告系列「${c.campaign_name ?? c.id}」有真实交易却断链（${reason}），请尽快到商家库手动填写平台追踪链接`,
        context: {
          hasRevenue: true,
          kind: 'broken_link_with_revenue',
          reason,
          campaignName: c.campaign_name,
          userMerchantId: mid ? mid.toString() : '0',
        },
      })
    } else {
      // 自愈中：清噪音、静默
      await resolveAlertsByType(userId, c.id, ['merchant_not_found'])
      health.selfHealing++
    }
  }

  return health
}

export async function GET(req: NextRequest) {
  if (!verifyCron(req)) {
    return NextResponse.json({ code: -1, message: '未授权' }, { status: 401 })
  }
  if (isRunning) {
    return NextResponse.json({ code: 0, data: { skipped: true, reason: 'already_running' } })
  }
  isRunning = true
  const startedAt = Date.now()

  try {
    const users = await prisma.users.findMany({
      where: { is_deleted: 0, status: 'active', role: { in: ['user', 'leader'] } },
      select: { id: true, username: true },
    })

    const totals = { usersScanned: 0, brokenTotal: 0, withRevenue: 0, selfHealing: 0, dismissed: 0 }
    for (const u of users) {
      try {
        const h = await checkUser(u.id)
        totals.usersScanned++
        totals.brokenTotal += h.brokenTotal
        totals.withRevenue += h.withRevenue
        totals.selfHealing += h.selfHealing
        totals.dismissed += h.dismissed
      } catch (e) {
        console.error('[cron/merchant-link-health] user error:', u.username, e instanceof Error ? e.message : e)
      }
    }

    console.log(
      `[cron/merchant-link-health] users=${totals.usersScanned} broken=${totals.brokenTotal} ` +
        `withRevenue=${totals.withRevenue} selfHealing(silenced)=${totals.selfHealing} ` +
        `dismissed(manual)=${totals.dismissed} cost=${Date.now() - startedAt}ms`,
    )
    return NextResponse.json({ code: 0, data: { ...totals, lookbackDays: REVENUE_LOOKBACK_DAYS } })
  } catch (error) {
    console.error('[cron/merchant-link-health] error:', error)
    return NextResponse.json({ code: -1, message: error instanceof Error ? error.message : '巡检失败' }, { status: 500 })
  } finally {
    isRunning = false
  }
}
