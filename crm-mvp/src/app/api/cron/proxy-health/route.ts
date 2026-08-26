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
import { checkTnbTraffic } from '@/lib/suffix-engine/tnbproxy-quota'

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

    // 1) 逐个不可用供应商 → 单独提醒（疑似到期/认证失败），文案按场景区分（D-271）。
    //    D-281：代理管理页「提醒」开关关闭的供应商静音（探活/熔断照常，只是不吵人）。
    for (const f of report.failed) {
      if (!f.alertEnabled) continue
      const isAi = f.scene === 'AI爬取'
      const sceneLabel = isAi ? 'AI爬取代理' : '换链接代理'
      const title = `[${sceneLabel}] ${f.name} 不可用（疑似到期/认证失败）`
      const content = [
        `代理供应商：${f.name}（${f.host}:${f.port}）`,
        `探活结果：${f.message}`,
        '',
        '常见原因：住宅代理流量包耗尽 / 订阅到期 / 账号被停用 / 凭据失效。',
        isAi
          ? '影响：AI 爬取/商品分类/竞品情报拿不到目标国家出口，相关任务会降级直连或跳过。'
          : '影响：该供应商无法生成换链接后缀，相关广告系列会逐步断货、库存偏低。',
        '处理：登录对应代理商后台检查账号流量/到期状态并续费，或在「后台 → 代理管理」更新/更换凭据后点「测试」验证。',
      ].join('\n')
      if (await notifyAdminOnce(title, content, { source: 'proxy-health', providerId: f.id, name: f.name, host: f.host, message: f.message })) {
        notified++
      }
    }

    // 2) 换链接场景供应商全部不可用 → 升级为整体告警（换链接生产将全面停摆）。
    //    D-271：按场景判定，不再看全表——否则 AI 行（arxlabs）活着会掩盖换链接全灭。
    const { isExchangeSceneRow } = await import('@/lib/suffix-engine/proxy-scene')
    const exHealthy = report.healthy.filter(isExchangeSceneRow)
    const exFailed = report.failed.filter(isExchangeSceneRow)
    const exTotal = exHealthy.length + exFailed.length
    if (exTotal > 0 && exHealthy.length === 0) {
      const title = `[换链接代理] 全部 ${exTotal} 家代理均不可用`
      const content = [
        `检测到全部 ${exTotal} 家 active 换链接代理供应商均探活失败：`,
        ...exFailed.map((f) => `  • ${f.name}（${f.host}:${f.port}）：${f.message}`),
        '',
        '换链接补货将全面停摆（无可用住宅代理生成后缀），请尽快续费/更换代理。',
      ].join('\n')
      if (await notifyAdminOnce(title, content, { source: 'proxy-health', scope: 'all_down', activeCount: exTotal })) {
        notified++
      }
    }

    // 3) kookeey 剩余流量 ≤ 阈值（默认 20GB）→ 主动写 admin 通知 + sendAlert 推送。
    //    2026-07-24 07 定调升级：此前「只做页面横幅、不发通知」，结果流量真实耗尽当天无人知晓、
    //    换链接补货断供才被动发现。现改为提前主动推送（24h 同标题去重防刷屏）；剩余 ≤5GB 时
    //    标题升级为「即将耗尽」，可在同一天内再触发一次更高优先级提醒。页面横幅保留不变。
    // D-281 提醒开关：流量告警按供应商行的 alert_enabled 门控（行不存在按开提醒处理，危险不静默）
    const alertOn = async (nameContains: string): Promise<boolean> => {
      const row = await prisma.kyads_proxies.findFirst({
        where: { name: { contains: nameContains }, is_deleted: 0 },
        select: { alert_enabled: true },
      })
      return row ? row.alert_enabled !== 0 : true
    }

    const traffic = await checkKookeeyTraffic()
    if (traffic.ok && traffic.low.length > 0 && (await alertOn('kookeey'))) {
      const critical = traffic.low.some((s) => s.trafficLeftGB <= 5)
      const title = critical
        ? '[换链接代理] kookeey 动态住宅流量即将耗尽'
        : '[换链接代理] kookeey 动态住宅流量偏低'
      const content = [
        `kookeey 动态住宅流量已低于告警阈值 ${traffic.thresholdGB} GB：`,
        ...traffic.low.map((s) => `  • 子账号 ${s.authname}（${s.name}）：剩余 ${s.trafficLeftGB} GB`),
        '',
        '流量耗尽后 SOCKS5 会认证失败、换链接补货全面中断（参考 D-176 事故）。',
        '请尽快登录 kookeey 后台购买/重置动态代理流量包。',
      ].join('\n')
      const meta = {
        source: 'proxy-health',
        scope: 'kookeey_traffic_low',
        thresholdGB: traffic.thresholdGB,
        low: traffic.low.map((s) => ({ authname: s.authname, trafficLeftGB: s.trafficLeftGB })),
      }
      if (await notifyAdminOnce(title, content, meta)) {
        notified++
      }
    }

    // 4) TnbProxy 剩余流量 ≤ 阈值（默认 20GB）→ 同 kookeey 的提前预警（D-280），受提醒开关门控
    const tnbTraffic = await checkTnbTraffic()
    if (tnbTraffic.ok && tnbTraffic.low && (await alertOn('tnb'))) {
      const critical = (tnbTraffic.remainingGB ?? 0) <= 5
      const title = critical
        ? '[换链接代理] tnbproxy 动态住宅流量即将耗尽'
        : '[换链接代理] tnbproxy 动态住宅流量偏低'
      const content = [
        `TnbProxy 动态住宅流量已低于告警阈值 ${tnbTraffic.thresholdGB} GB：`,
        `  • 套餐剩余 ${tnbTraffic.remainingGB} GB（已用 ${tnbTraffic.usedGB} GB）`,
        '',
        '流量耗尽后 SOCKS5 会认证失败；tnbproxy 是 kookeey 的兜底供应商，两家同时见底=换链接断供。',
        '请尽快登录 dash.tnbproxy.com 购买流量包。',
      ].join('\n')
      const meta = {
        source: 'proxy-health',
        scope: 'tnbproxy_traffic_low',
        thresholdGB: tnbTraffic.thresholdGB,
        remainingGB: tnbTraffic.remainingGB,
      }
      if (await notifyAdminOnce(title, content, meta)) {
        notified++
      }
    }

    console.log(
      `[cron/proxy-health] active=${report.activeCount} healthy=${report.healthy.length} failed=${report.failed.length}` +
        ` notified=${notified} cost=${Date.now() - startedAt}ms` +
        (report.failed.length ? ` downList=${report.failed.map((f) => f.name).join(',')}` : '') +
        (traffic.ok
          ? ` kookeeyTraffic=[${traffic.subAccounts.map((s) => s.authname + ':' + s.trafficLeftGB + 'GB').join(',')}]`
          : ` kookeeyTraffic=skip(${traffic.message})`) +
        (tnbTraffic.ok ? ` tnbTraffic=${tnbTraffic.remainingGB}GB` : ` tnbTraffic=skip(${tnbTraffic.message})`),
    )
    return NextResponse.json({ code: 0, data: { ...report, notified, kookeeyTraffic: traffic, tnbTraffic } })
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
