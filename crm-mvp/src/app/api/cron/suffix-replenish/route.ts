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
import { replenishLowStock, recycleSuffixes } from '@/lib/suffix-engine/stock-producer'
import { cleanupExpiredExitIps } from '@/lib/suffix-engine/exit-ip'
import { resolveAlertsForInactiveCampaigns } from '@/lib/suffix-engine/alerts'

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

  const startedAt = Date.now()

  // 生命周期回收（清过期出口 IP + 回收过期/卡死后缀 + 收敛僵尸告警）与重补货解耦：
  // 这三项都是轻量 updateMany，必须每轮心跳都跑。若像旧实现那样也压在 isRunning 锁内，
  // 一旦补货长时间占锁（低配机常态），回收连带被跳过 → 过期后缀持续堆积、被 lease 派发到 live 广告
  // （LE-03 #10 的连带隐患）。故先无条件回收，再对「重补货」单独判并发锁。
  const cleanedIps = await cleanupExpiredExitIps()
  const recycled = await recycleSuffixes()
  const zombieAlerts = await resolveAlertsForInactiveCampaigns()

  if (isRunning) {
    console.warn('[cron/suffix-replenish] 上一轮补货仍在执行，本轮只做回收、跳过补货')
    return NextResponse.json({
      code: 0,
      data: { skipped: true, cleanedExitIps: cleanedIps, recycled, zombieAlerts },
    })
  }
  isRunning = true

  try {
    const result = await replenishLowStock()
    console.log(
      `[cron/suffix-replenish] scanned=${result.scanned} lowStock=${result.lowStock} replenished=${result.replenished}` +
        ` cleanedExitIps=${cleanedIps} expired=${recycled.expiredAvailable} reclaimedLeased=${recycled.reclaimedLeased}` +
        ` zombieAlerts=${zombieAlerts} cost=${Date.now() - startedAt}ms`,
    )
    return NextResponse.json({ code: 0, data: { ...result, cleanedExitIps: cleanedIps, recycled, zombieAlerts } })
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
