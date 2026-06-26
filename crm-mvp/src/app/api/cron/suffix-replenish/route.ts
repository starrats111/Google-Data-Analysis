/**
 * GET /api/cron/suffix-replenish - 换链接库存自适应补货
 *
 * 扫描最近有 lease 活动且可用库存低于低水位的广告系列，按目标水位补货。
 * 替代旧的 /api/cron/click-tasks（粗糙单次 fetch 生成），改用 suffix-engine
 * （按投放国住宅代理跟随完整重定向链取落地页 query 串作 finalUrlSuffix）。
 *
 * crontab 示例（服务器）：
 *   每 5 分钟：
 *   星/5 * * * * curl -s -H 'Authorization: Bearer ${CRON_SECRET}' 'http://localhost:20050/api/cron/suffix-replenish' >> /var/log/cron-suffix-replenish.log 2>&1
 *
 * 鉴权：CRON_SECRET（Authorization: Bearer ...）
 */

import { NextRequest, NextResponse } from 'next/server'
import { replenishLowStock } from '@/lib/suffix-engine/stock-producer'
import { cleanupExpiredExitIps } from '@/lib/suffix-engine/exit-ip'

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
    console.warn('[cron/suffix-replenish] 上一轮仍在执行，本轮跳过')
    return NextResponse.json({ code: 0, data: { skipped: true } })
  }
  isRunning = true

  const startedAt = Date.now()
  try {
    // 顺带清理过期出口 IP 去重记录（轻量 deleteMany，复用本 5min cron 心跳）
    const cleanedIps = await cleanupExpiredExitIps()
    const result = await replenishLowStock()
    console.log(
      `[cron/suffix-replenish] scanned=${result.scanned} lowStock=${result.lowStock} replenished=${result.replenished} cleanedExitIps=${cleanedIps} cost=${Date.now() - startedAt}ms`,
    )
    return NextResponse.json({ code: 0, data: { ...result, cleanedExitIps: cleanedIps } })
  } catch (error) {
    console.error('[cron/suffix-replenish] error:', error)
    return NextResponse.json(
      { code: -1, message: error instanceof Error ? error.message : '补货失败' },
      { status: 500 },
    )
  } finally {
    isRunning = false
  }
}
