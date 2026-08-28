/**
 * D-298 失败归因纯函数（无 prisma / 网络依赖，便于单测）
 *
 * 为什么单独成文件（同 D-201 replenish-gate 的理由）：这里判的是「这次失败该记谁的账」，
 * 错了是**静默**的——不会抛错、日志上也看不出来，只会表现为几小时后告警中心冒出一批
 * 「链接不记点击」，而链接本身完全健康。2026-08-28 一次性误伤 101 个在投系列，就是
 * 这两个判定各漏了一支：
 *
 *   1. 硬代理错误（Socks5 Authentication failed / 连接被拒 / reset）原先返回 resolve_failed，
 *      进 handleProbeFailure 第 3 档「疑似死链」，累计 3 次报 invalid_link + 冻结 8 小时。
 *      可它的含义是**我们的代理没让我们出去**，这一轮压根没碰到联盟服务器，对链接零证据。
 *      当日 417 次，全部来自 tnbproxy 并发被打满。
 *
 *   2. 浏览器导航失败（chrome-error://chromewebdata/）原先不算「被挡住」，于是保留 HTTP 阶段的
 *      no_tracking 当结论上报，攒 3 轮就是 no_tracking_stuck。可 chromewebdata 是 Chrome 在
 *      传输层失败时的兜底页（ERR_PROXY_CONNECTION_FAILED / ERR_TUNNEL_CONNECTION_FAILED /
 *      ERR_CONNECTION_RESET / ERR_TIMED_OUT 都渲染成它），意思是「没连上」，不是「对方说了不」。
 *
 * 共同的判据：**这一轮有没有真正把点击送到联盟服务器**。没送到就不许对链接下结论。
 */

import { PROXY_HARD_ERR } from './proxy-circuit'

/**
 * 该错误是否为「硬代理失败」——代理层就没放我们出去，本轮未触达联盟服务器。
 *
 * 与 proxy-circuit 共用同一条正则：熔断器据此判代理有罪，失败归因据此判链接无罪，
 * 两边必须是同一个判据，否则又会出现「用它救代理、没用它救链接」的分叉（正是 D-298 病灶）。
 */
export function isProxyHardFailure(err: string | null | undefined): boolean {
  if (!err) return false
  return PROXY_HARD_ERR.test(err)
}
