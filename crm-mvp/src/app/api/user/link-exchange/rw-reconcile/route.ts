import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { getUserFromRequest } from '@/lib/auth'
import { normalizePlatformCode } from '@/lib/constants'
import {
  todayCST,
  nowCST,
  parseTxnDateStart,
  parseTxnDateEndExclusive,
  dateColumnStart,
  dateColumnTodayEndExclusive,
} from '@/lib/date-utils'

/**
 * RW 转化率反推自查（D-184，只读）
 *
 * 背景：Rewardoo（RW）是聚合型联盟（真实联盟为其下游 rakuten/partnerize/webgains 等），
 * 点击在下游域名注册，RW 的 click_details 接口对我方 medium token 恒返回 0 —— RW 点击不可见。
 * 但订单能回传、Google Ads 点击我方自有（ads_daily_stats）。
 *
 * 反推：联盟侧可见点击 ≈ Google 真实点击 + 我方刷点击（两者都打在同一条 RW 跟链上）。
 *   反推转化率 = RW订单 ÷ (Google点击 + 刷点击)
 * 目标：≤ 用户设定的 max_pct（默认 10%）。超标 = 稀释不到位（漏刷/风控风险）。
 *
 * 本接口纯只读聚合，不触发任何刷点击/写库。
 */
export async function GET(req: NextRequest) {
  const user = await getUserFromRequest(req)
  if (!user) return NextResponse.json({ code: -1, message: '未登录' }, { status: 401 })
  const userId = BigInt(user.userId)

  const daysRaw = Number(new URL(req.url).searchParams.get('days') ?? '3')
  const days = [3, 7, 14, 30].includes(daysRaw) ? daysRaw : 3

  const endDateStr = todayCST()
  const startDateStr = nowCST().subtract(days - 1, 'day').format('YYYY-MM-DD')
  // 订单/刷点击用 DATETIME(UTC) 列，按 CST 自然日窗口
  const startUTC = parseTxnDateStart(startDateStr)
  const endUTC = parseTxnDateEndExclusive(endDateStr)

  // 用户转化率区间（同 auto-click）
  const cfg = await prisma.users.findFirst({
    where: { id: userId, is_deleted: 0 },
    select: { click_control_ratio_min_pct: true, click_control_ratio_max_pct: true },
  })
  const minPct = cfg && cfg.click_control_ratio_min_pct > 0 ? cfg.click_control_ratio_min_pct : 5
  const maxPct = cfg && cfg.click_control_ratio_max_pct > minPct ? cfg.click_control_ratio_max_pct : Math.max(minPct + 1, 10)

  // RW 连接（用于展示账号名）
  const rwConns = await prisma.platform_connections.findMany({
    where: { user_id: userId, is_deleted: 0, platform: { in: ['RW', 'rewardoo'] } },
    select: { id: true, account_name: true, status: true },
  })
  const connName = new Map(rwConns.map((c) => [c.id.toString(), c.account_name || `#${c.id}`]))

  // 广告系列（在投 + 暂停；暂停后订单仍回传，转化率同样受影响）
  const campaigns = await prisma.campaigns.findMany({
    where: {
      user_id: userId,
      status: { in: ['active', 'paused'] },
      is_deleted: 0,
      google_campaign_id: { not: null },
      user_merchant_id: { not: BigInt(0) },
    },
    select: { id: true, user_merchant_id: true, platform_connection_id: true },
  })

  const umIds = [...new Set(campaigns.map((c) => c.user_merchant_id).filter((id): id is bigint => !!id && id > BigInt(0)))]
  const merchants = umIds.length
    ? await prisma.user_merchants.findMany({
        where: { id: { in: umIds }, user_id: userId, is_deleted: 0 },
        select: { id: true, platform: true, merchant_id: true, merchant_name: true, tracking_status: true, link_status: true },
      })
    : []
  const mById = new Map(merchants.map((m) => [m.id.toString(), m]))

  // 分组：仅 RW 商家，按 (连接, 商家) 聚合，收集其广告系列 id
  interface Group {
    conn: string
    merchantId: string
    merchantName: string
    trackingStatus: string | null
    linkStatus: string | null
    campaignIds: bigint[]
  }
  const groups = new Map<string, Group>()
  for (const c of campaigns) {
    const m = c.user_merchant_id ? mById.get(c.user_merchant_id.toString()) : undefined
    if (!m) continue
    if (normalizePlatformCode(m.platform || '') !== 'RW') continue
    const conn = c.platform_connection_id != null ? c.platform_connection_id.toString() : 'null'
    const mid = m.merchant_id || ''
    if (!mid) continue
    const key = `${conn}:${mid}`
    let g = groups.get(key)
    if (!g) {
      g = { conn, merchantId: mid, merchantName: m.merchant_name || mid, trackingStatus: m.tracking_status, linkStatus: m.link_status, campaignIds: [] }
      groups.set(key, g)
    }
    g.campaignIds.push(c.id)
  }

  if (groups.size === 0) {
    return NextResponse.json({
      code: 0,
      data: { rows: [], summary: { merchants: 0, overTarget: 0, noClickData: 0 }, ratio: { minPct, maxPct }, days, range: { start: startDateStr, end: endDateStr } },
    })
  }

  const allCampIds = [...groups.values()].flatMap((g) => g.campaignIds)

  // Google 点击（ads_daily_stats，DATE 列按 CST 归档；唯一键 campaign_id+date 无重复行）
  const ads = await prisma.ads_daily_stats.groupBy({
    by: ['campaign_id'],
    where: {
      user_id: userId,
      campaign_id: { in: allCampIds },
      is_deleted: 0,
      date: { gte: dateColumnStart(startDateStr), lt: dateColumnTodayEndExclusive() },
    },
    _sum: { clicks: true },
  })
  const gadsByCamp = new Map(ads.map((a) => [a.campaign_id.toString(), a._sum.clicks ?? 0]))

  // 刷点击成功（kyads_click_task_items，executed_at UTC → CST 窗口）
  const tasks = await prisma.kyads_click_tasks.findMany({
    where: { campaign_id: { in: allCampIds }, user_id: userId, is_deleted: 0 },
    select: { id: true, campaign_id: true },
  })
  const taskCamp = new Map(tasks.map((t) => [t.id.toString(), t.campaign_id.toString()]))
  const taskIds = tasks.map((t) => t.id)
  const brushByCamp = new Map<string, number>()
  if (taskIds.length > 0) {
    const items = await prisma.kyads_click_task_items.groupBy({
      by: ['task_id'],
      where: { task_id: { in: taskIds }, status: 'success', is_deleted: 0, executed_at: { gte: startUTC, lt: endUTC } },
      _count: { _all: true },
    })
    for (const it of items) {
      const camp = taskCamp.get(it.task_id.toString())
      if (!camp) continue
      brushByCamp.set(camp, (brushByCamp.get(camp) ?? 0) + it._count._all)
    }
  }

  // RW 订单（按 连接+商家；transaction_time UTC → CST 窗口）
  const orders = await prisma.affiliate_transactions.groupBy({
    by: ['platform_connection_id', 'merchant_id'],
    where: {
      user_id: userId,
      platform: { in: ['RW', 'rewardoo'] },
      is_deleted: 0,
      transaction_time: { gte: startUTC, lt: endUTC },
    },
    _count: { _all: true },
  })
  const ordByKey = new Map(
    orders.map((o) => [`${o.platform_connection_id != null ? o.platform_connection_id.toString() : 'null'}:${o.merchant_id}`, o._count._all]),
  )

  const rows = [...groups.values()].map((g) => {
    const gads = g.campaignIds.reduce((s, id) => s + (gadsByCamp.get(id.toString()) ?? 0), 0)
    const brush = g.campaignIds.reduce((s, id) => s + (brushByCamp.get(id.toString()) ?? 0), 0)
    const totalClicks = gads + brush
    const ord = ordByKey.get(`${g.conn}:${g.merchantId}`) ?? 0
    const convPct = totalClicks > 0 ? (ord / totalClicks) * 100 : null // null=有单但零点击（最坏）
    const overTarget = ord > 0 && (totalClicks === 0 || (convPct !== null && convPct > maxPct))
    return {
      conn: g.conn,
      connName: connName.get(g.conn) ?? (g.conn === 'null' ? '未回填' : `#${g.conn}`),
      merchantId: g.merchantId,
      merchantName: g.merchantName,
      trackingStatus: g.trackingStatus,
      linkStatus: g.linkStatus,
      gadsClicks: gads,
      brushClicks: brush,
      totalClicks,
      orders: ord,
      convPct: convPct !== null ? Math.round(convPct * 10) / 10 : null,
      overTarget,
    }
  })

  // 排序：超标优先，其中「有单零点击」最靠前，其余按转化率降序；无单的排后按点击降序
  rows.sort((a, b) => {
    if (a.overTarget !== b.overTarget) return a.overTarget ? -1 : 1
    const av = a.convPct === null ? Infinity : a.convPct
    const bv = b.convPct === null ? Infinity : b.convPct
    if (a.orders > 0 || b.orders > 0) return bv - av
    return b.totalClicks - a.totalClicks
  })

  const summary = {
    merchants: rows.length,
    overTarget: rows.filter((r) => r.overTarget).length,
    withOrders: rows.filter((r) => r.orders > 0).length,
    noClickData: rows.filter((r) => r.orders > 0 && r.totalClicks === 0).length,
  }

  return NextResponse.json({
    code: 0,
    data: { rows, summary, ratio: { minPct, maxPct }, days, range: { start: startDateStr, end: endDateStr } },
  })
}
