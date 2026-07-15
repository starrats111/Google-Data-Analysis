/**
 * 代理出口 IP 去重（移植 kylink proxy-selector 的 ProxyExitIpUsage 思想，适配 CRM）
 *
 * 背景：CRM 的住宅代理供应商（kookeey/cliproxy/ipip）用户名模板都带随机会话 token + 几分钟粘性
 * （如 session-{session:8}-life-5m、sid-{random:8}-t-5）。因此：
 *   - 每次调用 getProxyUrlForCountry 生成一个「新会话」→ 一个新的粘性出口 IP；
 *   - 同一个 proxyUrl 在粘性周期内出口 IP 稳定 → 可「先探 IP、再用同一 URL 生成」，记录准确。
 *
 * F-IPDEDUP-01 去重范围升级为「跨用户、不跨组」（07 定调）：
 *   - 去重键 = (team_id, platform, merchant_id)，匹配联盟/商家反作弊「同商家名下多订单同 IP/同段」的视角
 *     （刷点击的代理出口 IP 会经 clickid 归因成订单来源 IP）。
 *   - 同时按【精确 IP】与【/24 子网段】判重——商家风控常按段判定，实测 /24 撞车率是精确 IP 的 3 倍。
 *   - team_id 为 NULL 的用户不参与换链接，天然不进入组级去重（调用方不传 scope 即退化为「无去重仍可换链」）。
 *
 * 去重策略：
 *   1. getUsedExitIps：取该组该商家 24h 内已用「出口 IP + /24 段」集合
 *   2. acquireDedupedProxy：建会话 → 探出口 IP；命中已用 IP 或已用 /24 段则换会话重试，最多 N 次；
 *      取到「未用过」的会话即返回；全部命中则返回最后一次（尽力而为，不阻断换链）
 *   3. 生成成功后 recordExitIp 落库（24h 过期，含 team/platform/merchant/subnet），并写 suffix_pool.exit_ip / click item.exit_ip
 *   4. cleanupExpiredExitIps 定期清理过期记录
 *
 * 探活/换会话失败均不阻断主流程（降级为「无去重」，仍能换链）。
 */

import { prisma } from '@/lib/prisma'
import { getProxyUrlForCountry, fetchViaProxy } from '@/lib/crawl-proxy'
import { getProviderSelection } from './proxy-provider'

/** 去重范围：跨用户、不跨组，按 (team_id, platform, merchant_id) 聚合。 */
export interface DedupScope {
  /** users.team_id；NULL/缺省=未分组，不做组级去重 */
  teamId?: bigint | null
  /** 联盟平台代号 */
  platform?: string | null
  /** 联盟平台商家 ID（字符串，跨用户对同一真实商家一致） */
  merchantId?: string | null
  /** 生成方 user（仅审计落库用，不参与去重键） */
  userId?: bigint | null
  /** 生成方 campaign（仅审计落库用，不参与去重键） */
  campaignId?: bigint | null
}

/** scope 是否足以做组级去重（必须同时有 team_id + platform + merchant_id）。 */
function canDedup(scope?: DedupScope | null): scope is DedupScope & { teamId: bigint; platform: string; merchantId: string } {
  return !!scope && scope.teamId != null && scope.teamId > BigInt(0) && !!scope.platform && !!scope.merchantId
}

/**
 * 计算出口 IP 的子网段：IPv4 取 /24（前 3 段），IPv6 取 /64（前 4 组）。
 * 无法识别的格式原样返回，保证仍能按精确 IP 去重。
 */
export function computeSubnet(ip: string): string {
  const s = (ip || '').trim()
  if (!s) return ''
  if (s.includes(':')) {
    // IPv6：取前 4 组作为 /64
    const groups = s.split(':')
    return groups.slice(0, 4).join(':') + '::/64'
  }
  const parts = s.split('.')
  if (parts.length === 4) return `${parts[0]}.${parts[1]}.${parts[2]}.0/24`
  return s
}

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
  /** true=所有尝试都命中 24h 已用 IP/段（尽力而为返回最后一个），用于诊断 */
  dup: boolean
  /** 选中的供应商 id（走 system_config/env 兜底或无供应商时为 null）；供调用方向熔断器归因成败 */
  providerId: string | null
}

/** 组级已用集合：精确 IP 与 /24 子网段各一份，acquireDedupedProxy 用其判重。 */
export interface UsedExit {
  ips: Set<string>
  subnets: Set<string>
}

/** 取某组该商家 24h 内已使用的「出口 IP + /24 段」集合（跨用户、不跨组）。 */
export async function getUsedExitIps(scope: DedupScope): Promise<UsedExit> {
  const empty: UsedExit = { ips: new Set(), subnets: new Set() }
  if (!canDedup(scope)) return empty
  try {
    const since = new Date(Date.now() - DEDUP_WINDOW_MS)
    const rows = await prisma.proxy_exit_ip_usage.findMany({
      where: {
        team_id: scope.teamId,
        platform: scope.platform,
        merchant_id: scope.merchantId,
        used_at: { gte: since },
      },
      select: { exit_ip: true, exit_subnet: true },
    })
    const ips = new Set<string>()
    const subnets = new Set<string>()
    for (const r of rows) {
      if (r.exit_ip) ips.add(r.exit_ip)
      if (r.exit_subnet) subnets.add(r.exit_subnet)
      else if (r.exit_ip) subnets.add(computeSubnet(r.exit_ip)) // 旧行无 subnet 列时现算，保证段级判重不漏
    }
    return { ips, subnets }
  } catch (e) {
    console.warn('[exit-ip] getUsedExitIps 失败:', e instanceof Error ? e.message : e)
    return empty
  }
}

/** 记录一次出口 IP 使用（24h 后过期，含组级去重键与子网）。失败不阻断主流程。 */
export async function recordExitIp(scope: DedupScope, exitIp: string): Promise<void> {
  if (!exitIp) return
  try {
    await prisma.proxy_exit_ip_usage.create({
      data: {
        user_id: scope.userId ?? BigInt(0),
        campaign_id: scope.campaignId ?? BigInt(0),
        team_id: scope.teamId ?? null,
        platform: scope.platform ?? null,
        merchant_id: scope.merchantId ?? null,
        exit_ip: exitIp,
        exit_subnet: computeSubnet(exitIp) || null,
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
 * 取一个「出口 IP 与 /24 段都未在 24h 内为该组该商家使用过」的粘性代理。
 * 每次 getProxyUrlForCountry 生成新会话（新出口 IP）；命中已用 IP 或已用 /24 段则换会话重试。
 * 探活失败时返回当前会话 + exitIp=null（降级无去重，仍可换链）。
 */
export async function acquireDedupedProxy(
  country: string,
  opts: { userId?: bigint | null; used?: UsedExit },
): Promise<DedupedProxy> {
  const usedIps = opts.used?.ips ?? new Set<string>()
  const usedSubnets = opts.used?.subnets ?? new Set<string>()
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
    // 精确 IP 或 /24 段任一撞已用即视为重复（商家风控按段判定，段级更严）
    if (!usedIps.has(ip) && !usedSubnets.has(computeSubnet(ip))) {
      return { proxyUrl, exitIp: ip, dup: false, providerId }
    }
    // 命中 24h 已用 IP/段 → 换会话再试
  }

  // 多次都命中已用 IP/段：尽力而为返回最后一个（不阻断换链；rotating 池 IP 有限时可能发生）。
  // 记一条可观测日志——组级去重下反复撞车 = 该组该商家 24h 内已把可用 IP/段耗尽，是「扩代理池」的量化信号
  // （F-IPDEDUP-01 第二轮据此加日报警；当前先经日志暴露，避免噪音进告警中心）。
  if (usedIps.size > 0 || usedSubnets.size > 0) {
    console.warn(
      `[exit-ip] dedup 撞车耗尽(${country})：${MAX_FRESH_TRIES} 次探测均命中已用 IP/段（已用 IP=${usedIps.size} 段=${usedSubnets.size}），本次复用 ${lastIp ?? 'unknown'}`,
    )
  }
  return { proxyUrl: lastUrl, exitIp: lastIp, dup: true, providerId: lastProviderId }
}
