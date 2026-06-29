/**
 * GET /api/cron/click-sync — 需求2：联盟点击同步（写 affiliate_click_daily）
 *
 * 仅同步开启 click_control_enabled 的用户的连接；逐用户串行（低配机保护）。
 * 各平台 click API 的窗口切片/限频由 fetchAllClicks 内部处理。
 *
 * 鉴权：CRON_SECRET（Authorization: Bearer ...）
 * 建议每 30-60 分钟一跑（与订单同步错峰）：
 *   星/45 * * * * curl -s -H 'Authorization: Bearer ${CRON_SECRET}' 'http://localhost:20050/api/cron/click-sync' >> /var/log/cron-click-sync.log 2>&1
 */

import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { syncUserClicks } from '@/lib/affiliate-click-sync'

export const dynamic = 'force-dynamic'
export const maxDuration = 300

let isRunning = false

function verifyCron(req: NextRequest): boolean {
  const secret = process.env.CRON_SECRET
  if (!secret) return false
  return req.headers.get('authorization') === `Bearer ${secret}`
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
      where: { is_deleted: 0, status: 'active', click_control_enabled: 1, role: { in: ['user', 'leader'] } },
      select: { id: true, username: true },
    })

    const totals = { usersScanned: 0, connectionsSynced: 0, rowsUpserted: 0, clicksCounted: 0, errors: 0 }
    for (const u of users) {
      try {
        const r = await syncUserClicks(u.id)
        totals.usersScanned++
        totals.connectionsSynced += r.connectionsSynced
        totals.rowsUpserted += r.rowsUpserted
        totals.clicksCounted += r.clicksCounted
        totals.errors += r.errors.length
        if (r.errors.length > 0) {
          console.warn(`[cron/click-sync] ${u.username} errors: ${r.errors.join(' | ')}`)
        }
      } catch (e) {
        totals.errors++
        console.error('[cron/click-sync] user error:', u.username, e instanceof Error ? e.message : e)
      }
    }

    console.log(
      `[cron/click-sync] users=${totals.usersScanned} conns=${totals.connectionsSynced} ` +
        `rows=${totals.rowsUpserted} clicks=${totals.clicksCounted} errors=${totals.errors} cost=${Date.now() - startedAt}ms`,
    )
    return NextResponse.json({ code: 0, data: totals })
  } catch (error) {
    console.error('[cron/click-sync] error:', error)
    return NextResponse.json({ code: -1, message: error instanceof Error ? error.message : '点击同步失败' }, { status: 500 })
  } finally {
    isRunning = false
  }
}
