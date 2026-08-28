/**
 * 换链接代理「流量告警要不要发」的统一门控（D-297）
 *
 * 口径：以代理管理页（kyads_proxies）为准——
 *   - 该供应商没有未删除的行  → 已经不用这家了，一律不告警；
 *   - 有行但 alert_enabled=0  → 07 手动关了提醒，静音（D-281）；
 *   - 有行且 alert_enabled≠0  → 正常告警。
 *
 * 为什么改掉 D-281 的「行不存在按开提醒处理」：2026-08-28 kookeey 被删换成 tnbproxy 后，
 * 查不到行反而被当成「提醒开着」，而 kookeey 账号余额本就是 0GB，
 * 换链接管理页横幅与 proxy-health 定时通知就永久挂着一条已经作废的告警。
 * 现在删掉哪家就不再报哪家；哪天在代理管理页重新加回来，告警自动恢复。
 */

import { prisma } from '@/lib/prisma'

/** nameContains：代理名里的供应商关键字，如 'kookeey' / 'tnb' */
export async function isProxyAlertOn(nameContains: string): Promise<boolean> {
  const row = await prisma.kyads_proxies.findFirst({
    where: { name: { contains: nameContains }, is_deleted: 0 },
    select: { alert_enabled: true },
  })
  return !!row && row.alert_enabled !== 0
}
