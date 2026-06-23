/**
 * GET /api/cron/kylink-sync - 每小时把 CRM 商家库联盟链接喂给 kylink
 *
 * crontab 示例（服务器）：
 *   0 * * * * curl -s -H 'Authorization: Bearer ${CRON_SECRET}' 'http://localhost:20050/api/cron/kylink-sync' >> /var/log/cron-kylink-sync.log 2>&1
 *
 * 鉴权：CRON_SECRET（Authorization: Bearer ...）
 */

import { NextRequest, NextResponse } from 'next/server'
import { syncAllUsers } from '@/lib/kylink-sync'

export const dynamic = 'force-dynamic'
export const maxDuration = 300

// 进程内重入锁：单次运行未结束前，后续触发直接跳过，防止两轮重叠。
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
    console.warn('[cron/kylink-sync] 上一轮仍在执行，本轮跳过')
    return NextResponse.json({ code: 0, data: { skipped: true } })
  }
  isRunning = true

  const startedAt = Date.now()
  try {
    const result = await syncAllUsers()
    console.log(
      `[cron/kylink-sync] users=${result.users} success=${result.totalSuccess} failed=${result.totalFailed} cost=${Date.now() - startedAt}ms`
    )
    return NextResponse.json({ code: 0, data: result })
  } catch (error) {
    console.error('[cron/kylink-sync] error:', error)
    return NextResponse.json(
      { code: -1, message: error instanceof Error ? error.message : 'kylink 同步失败' },
      { status: 500 }
    )
  } finally {
    isRunning = false
  }
}
