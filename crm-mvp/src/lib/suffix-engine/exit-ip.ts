/**
 * 代理出口 IP 去重（移植 kylink proxy-selector 的 ProxyExitIpUsage 思想，适配 CRM）
 *
 * 背景：CRM 的住宅代理供应商（kookeey/cliproxy/ipip）用户名模板都带随机会话 token + 几分钟粘性
 * （如 session-{session:8}-life-5m、sid-{random:8}-t-5）。因此：
 *   - 每次调用 getProxyUrlForCountry 生成一个「新会话」→ 一个新的粘性出口 IP；
 *   - 同一个 proxyUrl 在粘性周期内出口 IP 稳定 → 可「先探 IP、再用同一 URL 生成」，记录准确。
 *
 * 去重策略（按 user+campaign）：
 *   1. 取该系列 24h 内已用出口 IP 集合（getUsedExitIps）
 *   2. acquireDedupedProxy：建会话 → 探出口 IP；命中 24h 已用则换会话重试，最多 N 次；
 *      取到「未用过」的会话即返回；全部命中则返回最后一次（尽力而为，不阻断换链）
 *   3. 生成成功后 recordExitIp 落库（24h 过期），并写 suffix_pool.exit_ip / click item.exit_ip
 *   4. cleanupExpiredExitIps 定期清理过期记录
 *
 * 探活/换会话失败均不阻断主流程（降级为「无去重」，仍能换链）。
 */

import { prisma } from '@/lib/prisma'
import { getProxyUrlForCountry, fetchViaProxy } from '@/lib/crawl-proxy'
import { getProviderSelection } from './proxy-provider'

/** 去重窗口：24 小时 */
const DEDUP_WINDOW_MS = 24 * 60 * 60 * 1000
/** 探到重复 IP 时，最多换几次会话找新 IP。
 *  ⚠️ 每次尝试都会新建一个 kookeey 粘性会话（life-5m），失败/丢弃的会话仍占用上游 IP 5 分钟。
 *  16 用户共用单子账号时这是并发放大的主因，故从 4 收敛到 2：仍保留基本去重、把探测会话减半。 */
const MAX_FRESH_TRIES = 2
/** 出口 IP 探活超时（毫秒），需在 suffix 生成预算内 */
const PROBE_TIMEOUT_MS = 6000

export interface DedupedProxy {
  /** 选定的粘性代理 URL（拿不到供应商代理时为 null，调用方应让 resolver 内部兜底） */
  proxyUrl: string | null
  /** 探到的出口 IP（探活失败时为 null） */
  exitIp: string | null
  /** true=所有尝试都命中 24h 已用 IP（尽力而为返回最后一个），用于诊断 */
  dup: boolean
  /** 选中的供应商 id（走 system_config/env 兜底或无供应商时为 null）；供调用方向熔断器归因成败 */
  providerId: string | null
}

/** 取某系列 24h 内已使用的出口 IP 集合 */
export async function getUsedExitIps(userId: bigint, campaignId: bigint): Promise<Set<string>> {
  try {
    const since = new Date(Date.now() - DEDUP_WINDOW_MS)
    const rows = await prisma.proxy_exit_ip_usage.findMany({
      where: { user_id: userId, campaign_id: campaignId, used_at: { gte: since } },
      select: { exit_ip: true },
    })
    return new Set(rows.map((r) => r.exit_ip))
  } catch (e) {
    console.warn('[exit-ip] getUsedExitIps 失败:', e instanceof Error ? e.message : e)
    return new Set()
  }
}

/** 记录一次出口 IP 使用（24h 后过期）。失败不阻断主流程。 */
export async function recordExitIp(userId: bigint, campaignId: bigint, exitIp: string): Promise<void> {
  if (!exitIp) return
  try {
    await prisma.proxy_exit_ip_usage.create({
      data: {
        user_id: userId,
        campaign_id: campaignId,
        exit_ip: exitIp,
        used_at: new Date(),
        expires_at: new Date(Date.now() + DEDUP_WINDOW_MS),
      },
    })
  } catch (e) {
    console.warn('[exit-ip] recordExitIp 失败:', e instanceof Error ? e.message : e)
  }
}

/** 清理过期出口 IP 记录，返回删除条数。 */
export async function cleanupExpiredExitIps(): Promise<number> {
  try {
    const res = await prisma.proxy_exit_ip_usage.deleteMany({ where: { expires_at: { lt: new Date() } } })
    return res.count
  } catch (e) {
    console.warn('[exit-ip] cleanupExpiredExitIps 失败:', e instanceof Error ? e.message : e)
    return 0
  }
}

/** 通过指定代理 URL 探出口 IP（访问 ipinfo.io/json）。失败返回 null。 */
export async function probeExitIp(proxyUrl: string): Promise<string | null> {
  const ctrl = new AbortController()
  const tm = setTimeout(() => ctrl.abort(), PROBE_TIMEOUT_MS)
  try {
    const resp = await fetchViaProxy('https://ipinfo.io/json', { signal: ctrl.signal }, proxyUrl, 3)
    if (!resp.ok) return null
    const json = JSON.parse(await resp.text()) as { ip?: string }
    return json.ip ? String(json.ip).trim() : null
  } catch {
    return null
  } finally {
    clearTimeout(tm)
  }
}

/**
 * 取一个「出口 IP 未在 24h 内为该系列使用过」的粘性代理。
 * 每次 getProxyUrlForCountry 生成新会话（新出口 IP）；命中已用 IP 则换会话重试。
 * 探活失败时返回当前会话 + exitIp=null（降级无去重，仍可换链）。
 */
export async function acquireDedupedProxy(
  country: string,
  opts: { userId?: bigint | null; campaignId?: bigint | null; usedIps?: Set<string> },
): Promise<DedupedProxy> {
  const usedIps = opts.usedIps ?? new Set<string>()
  let lastUrl: string | null = null
  let lastIp: string | null = null
  let lastProviderId: string | null = null

  for (let i = 0; i < MAX_FRESH_TRIES; i++) {
    // 优先走供应商选择（含熔断故障转移 + 回传 providerId 供归因）；无供应商时回退 system_config/env 模板。
    const sel = await getProviderSelection(country, { userId: opts.userId }).catch(() => null)
    let proxyUrl: string | null
    let providerId: string | null
    if (sel) {
      proxyUrl = sel.url
      providerId = sel.providerId
    } else {
      proxyUrl = await getProxyUrlForCountry(country, { userId: opts.userId }).catch(() => null)
      providerId = null
    }
    if (!proxyUrl) {
      // 无供应商代理且无兜底模板：交给 resolver 内部兜底（env/直连），不做去重
      return { proxyUrl: null, exitIp: null, dup: false, providerId: null }
    }
    lastUrl = proxyUrl
    lastProviderId = providerId
    const ip = await probeExitIp(proxyUrl)
    if (!ip) {
      // 探活失败：用当前会话，放弃去重（降级），不再多探以省时间
      return { proxyUrl, exitIp: null, dup: false, providerId }
    }
    lastIp = ip
    if (!usedIps.has(ip)) {
      return { proxyUrl, exitIp: ip, dup: false, providerId }
    }
    // 命中 24h 已用 → 换会话再试
  }

  // 多次都命中已用 IP：尽力而为返回最后一个（不阻断换链；rotating 池 IP 有限时可能发生）
  return { proxyUrl: lastUrl, exitIp: lastIp, dup: true, providerId: lastProviderId }
}
