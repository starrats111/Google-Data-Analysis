/**
 * GET /api/cron/proxy-health - 换链接代理主动健康预警
 *
 * 定期探活每个 active 代理供应商（kyads_proxies）。一旦某家 SOCKS5 认证失败 / 连接被断 / 超时
 * （典型「配额耗尽 / 订阅到期 / 凭据失效」信号），立刻给 admin 写一条通知——做到「到期即提醒」，
 * 而不是等换链接补货大面积失败、告警堆积后才被动发现。
 *
 * crontab 示例（服务器，每 30 分钟）：
 *   星/30 * * * * curl -s -H 'Authorization: Bearer ${CRON_SECRET}' 'http://localhost:20050/api/cron/proxy-health' >> /var/log/crm-cron/proxy-health.log 2>&1
 *
 * 鉴权：CRON_SECRET（Authorization: Bearer ...）
 */

import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { checkAllProxiesHealth } from '@/lib/suffix-engine/proxy-health'
import { checkKookeeyTraffic } from '@/lib/suffix-engine/kookeey-quota'

export const dynamic = 'force-dynamic'
export const maxDuration = 120

const ADMIN_USER_ID = BigInt(1) // 系统默认 admin
const ALERT_DEDUP_HOURS = 24 // 同一供应商 24h 内只提醒一次，防刷屏

let isRunning = false

function verifyCron(req: NextRequest): boolean {
  const secret = process.env.CRON_SECRET
  if (!secret) return false
  return req.headers.get('authorization') === `Bearer ${secret}`
}

/** 若 24h 内未就该 title 通知过，则写一条 admin 通知。返回是否实际写入。 */
async function notifyAdminOnce(title: string, content: string, metadata: Record<string, unknown>): Promise<boolean> {
  const recentDup = await prisma.notifications.count({
    where: {
      user_id: ADMIN_USER_ID,
      type: 'alert',
      title,
      created_at: { gte: new Date(Date.now() - ALERT_DEDUP_HOURS * 3600 * 1000) },
      is_deleted: 0,
    },
  })
  if (recentDup > 0) return false
  await prisma.notifications.create({
    data: {
      user_id: ADMIN_USER_ID,
      type: 'alert',
      title,
      content,
      metadata: JSON.stringify(metadata, (_, v) => (typeof v === 'bigint' ? v.toString() : v)),
    },
  })
  const { sendAlert } = await import('@/lib/alert')
  void sendAlert({ level: 'warning', title, content, source: 'cron/proxy-health' })
  return true
}

export async function GET(req: NextRequest) {
  if (!verifyCron(req)) {
    return NextResponse.json({ code: -1, message: '未授权' }, { status: 401 })
  }
  if (isRunning) {
    return NextResponse.json({ code: 0, data: { skipped: true } })
  }
  isRunning = true

  const startedAt = Date.now()
  try {
    const report = await checkAllProxiesHealth()
    let notified = 0

    // 1) 逐个不可用供应商 → 单独提醒（疑似到期/认证失败）
    for (const f of report.failed) {
      const title = `[换链接代理] ${f.name} 不可用（疑似到期/认证失败）`
      const content = [
        `代理供应商：${f.name}（${f.host}:${f.port}）`,
        `探活结果：${f.message}`,
        '',
        '常见原因：住宅代理流量包耗尽 / 订阅到期 / 账号被停用 / 凭据失效。',
        '影响：该供应商无法生成换链接后缀，相关广告系列会逐步断货、库存偏低。',
        '处理：登录对应代理商后台检查账号流量/到期状态并续费，或在「后台 → 代理管理」更新/更换凭据后点「测试」验证。',
      ].join('\n')
      if (await notifyAdminOnce(title, content, { source: 'proxy-health', providerId: f.id, name: f.name, host: f.host, message: f.message })) {
        notified++
      }
    }

    // 2) active 供应商全部不可用 → 升级为整体告警（换链接生产将全面停摆）
    if (report.activeCount > 0 && report.healthy.length === 0) {
      const title = `[换链接代理] 全部 ${report.activeCount} 家代理均不可用`
      const content = [
        `检测到全部 ${report.activeCount} 家 active 代理供应商均探活失败：`,
        ...report.failed.map((f) => `  • ${f.name}（${f.host}:${f.port}）：${f.message}`),
        '',
        '换链接补货将全面停摆（无可用住宅代理生成后缀），请尽快续费/更换代理。',
      ].join('\n')
      if (await notifyAdminOnce(title, content, { source: 'proxy-health', scope: 'all_down', activeCount: report.activeCount })) {
        notified++
      }
    }

    // 3) kookeey 剩余流量：仅记录日志用于运维观测。用户要求「≤阈值只在换链接页面横幅提醒重置，
    //    不发站内通知」，故此处不再写 notification —— 横幅由 overview 接口的 proxyStatus 驱动。
    const traffic = await checkKookeeyTraffic()

    console.log(
      `[cron/proxy-health] active=${report.activeCount} healthy=${report.healthy.length} failed=${report.failed.length}` +
        ` notified=${notified} cost=${Date.now() - startedAt}ms` +
        (report.failed.length ? ` downList=${report.failed.map((f) => f.name).join(',')}` : '') +
        (traffic.ok
          ? ` kookeeyTraffic=[${traffic.subAccounts.map((s) => s.authname + ':' + s.trafficLeftGB + 'GB').join(',')}]`
          : ` kookeeyTraffic=skip(${traffic.message})`),
    )
    return NextResponse.json({ code: 0, data: { ...report, notified, kookeeyTraffic: traffic } })
  } catch (error) {
    console.error('[cron/proxy-health] error:', error)
    return NextResponse.json(
      { code: -1, message: error instanceof Error ? error.message : '代理健康检查失败' },
      { status: 500 },
    )
  } finally {
    isRunning = false
  }
}
