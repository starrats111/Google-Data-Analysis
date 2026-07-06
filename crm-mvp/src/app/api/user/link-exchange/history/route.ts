import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { getUserFromRequest } from '@/lib/auth'
import { todayCST, parseCSTDateStart, dateColumnStart, TZ } from '@/lib/date-utils'
import dayjs from 'dayjs'
import utc from 'dayjs/plugin/utc'
import timezone from 'dayjs/plugin/timezone'

dayjs.extend(utc)
dayjs.extend(timezone)

/**
 * GET /api/user/link-exchange/history?days=7 — 换链接历史记录（只读）
 *
 * 回答用户诉求：
 *  1) 「今天看不到昨天有没有实际刷的次数」→ 按天列出刷点击成功/失败次数、库存产出条数；
 *  2) 「核对前两天刷的次数(点击数)有没有生效」→ 同表并列联盟平台侧统计到的点击数。
 *
 * 口径说明：
 *  - 刷点击成功/失败：kyads_click_task_items（真人作息曲线执行的每次点击），按 executed_at 东八区切天；
 *  - 库存产出：suffix_pool 当天新增（含「补货」与「刷点击」两条产线，均写入同一库存池），按 created_at 东八区切天；
 *  - 联盟平台点击：affiliate_click_daily（联盟后台 API 回传的真实点击，DATE 列直接按平台日期）。
 *  三者对照即可判断「刷了多少 / 库存补了多少 / 平台是否统计到（生效）」。
 */
export async function GET(req: NextRequest) {
  const user = await getUserFromRequest(req)
  if (!user) return NextResponse.json({ code: -1, message: '未登录' }, { status: 401 })
  const userId = BigInt(user.userId)

  const daysParam = parseInt(req.nextUrl.searchParams.get('days') ?? '7', 10)
  const days = Math.min(Math.max(Number.isFinite(daysParam) ? daysParam : 7, 1), 31)

  // MySQL raw 查询里 COUNT 返回 bigint、SUM 返回 Decimal/字符串，先转字符串再转 number 最稳妥
  const num = (v: unknown): number => Number(String(v ?? 0)) || 0

  const todayStr = todayCST()
  const startStr = dayjs.tz(`${todayStr} 00:00:00`, TZ).subtract(days - 1, 'day').format('YYYY-MM-DD')
  const startDateTimeUTC = parseCSTDateStart(startStr) // DATETIME 列（UTC 存储）的下界
  const startDateCol = dateColumnStart(startStr) // DATE 列（affiliate_click_daily.click_date）的下界

  // 1) 刷点击：按天 + 系列，成功/失败次数
  const brushRows = await prisma.$queryRawUnsafe<
    { d: string; cid: bigint; name: string | null; ok: bigint; fail: bigint }[]
  >(
    `SELECT DATE_FORMAT(CONVERT_TZ(i.executed_at, '+00:00', '+08:00'), '%Y-%m-%d') AS d,
            t.campaign_id AS cid,
            c.campaign_name AS name,
            SUM(i.status = 'success') AS ok,
            SUM(i.status = 'failed') AS fail
     FROM kyads_click_task_items i
     JOIN kyads_click_tasks t ON t.id = i.task_id
     LEFT JOIN campaigns c ON c.id = t.campaign_id
     WHERE t.user_id = ? AND i.is_deleted = 0 AND i.executed_at IS NOT NULL
       AND i.executed_at >= ?
     GROUP BY d, t.campaign_id, c.campaign_name
     ORDER BY d DESC, ok DESC`,
    userId,
    startDateTimeUTC,
  )

  // 2) 库存产出：suffix_pool 按天新增条数
  const stockRows = await prisma.$queryRawUnsafe<{ d: string; gen: bigint }[]>(
    `SELECT DATE_FORMAT(CONVERT_TZ(created_at, '+00:00', '+08:00'), '%Y-%m-%d') AS d,
            COUNT(*) AS gen
     FROM suffix_pool
     WHERE user_id = ? AND is_deleted = 0 AND created_at >= ?
     GROUP BY d`,
    userId,
    startDateTimeUTC,
  )

  // 3) 联盟平台侧点击：affiliate_click_daily 按天汇总
  const affRows = await prisma.$queryRawUnsafe<{ d: string; clk: bigint }[]>(
    `SELECT DATE_FORMAT(click_date, '%Y-%m-%d') AS d,
            COALESCE(SUM(clicks), 0) AS clk
     FROM affiliate_click_daily
     WHERE user_id = ? AND is_deleted = 0 AND click_date >= ?
     GROUP BY d`,
    userId,
    startDateCol,
  )

  const stockByDay = new Map(stockRows.map((r) => [r.d, num(r.gen)]))
  const affByDay = new Map(affRows.map((r) => [r.d, num(r.clk)]))
  const brushByDay = new Map<string, { ok: number; fail: number }>()
  for (const r of brushRows) {
    const cur = brushByDay.get(r.d) ?? { ok: 0, fail: 0 }
    cur.ok += num(r.ok)
    cur.fail += num(r.fail)
    brushByDay.set(r.d, cur)
  }

  // 生成完整日期轴（含无活动日，明确显示 0，直接回答「昨天有没有刷」）
  const daily: {
    date: string
    brushSuccess: number
    brushFailed: number
    replenished: number
    affiliateClicks: number
  }[] = []
  for (let i = 0; i < days; i++) {
    const d = dayjs.tz(`${todayStr} 00:00:00`, TZ).subtract(i, 'day').format('YYYY-MM-DD')
    const b = brushByDay.get(d) ?? { ok: 0, fail: 0 }
    daily.push({
      date: d,
      brushSuccess: b.ok,
      brushFailed: b.fail,
      replenished: stockByDay.get(d) ?? 0,
      affiliateClicks: affByDay.get(d) ?? 0,
    })
  }

  // 每日按系列的刷点击明细（供前端展开查看）
  const byCampaign = brushRows.map((r) => ({
    date: r.d,
    campaignId: r.cid.toString(),
    campaignName: r.name,
    success: num(r.ok),
    failed: num(r.fail),
  }))

  return NextResponse.json({ code: 0, data: { days, daily, byCampaign } })
}
