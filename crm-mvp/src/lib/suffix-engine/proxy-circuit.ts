/**
 * 住宅代理供应商级熔断器（进程内，PM2 单进程常驻，跨 cron 轮次保留）
 *
 * 治「单个代理供应商全站降级时仍被反复选中、健康代理全程闲置」——见 2026-06-30 kookeey
 * 事故：kookeey（priority 1）单点全天降级，pickProvider 每次仍只返回它，cliproxy/ipip 两个
 * 健康代理闲置，全站 14 用户成功率跌到 24.7%，只能等人手动改 DB status 才恢复。
 *
 * 双信号驱动：
 *  A. 主动探活（proxy-health cron，每 30min）：探活失败 → openProvider；成功 → clearProvider。
 *  B. 真实生成失败（suffix-generator）：命中「硬代理错误」（SOCKS5 认证失败/连接被拒/reset）
 *     → reportProviderResult(id, false)；成功/跟到落地页 → reportProviderResult(id, true)。
 *
 * selectHealthy 供 pickProvider 跳过 open 的供应商、按 priority 顺延到下一个健康供应商；
 * 全部 open 时返回「最快恢复者」（尽力而为不停摆）。open 为带过期时间(openUntil)的软隔离：
 * 到期自动 half-open，下次真实请求再试，成功即清除、仍失败则立即再断。
 */

/** 连续硬失败达到此数即熔断（reactive 路径） */
const FAIL_THRESHOLD = 5
/** 真实失败驱动的熔断冷却时长（坏多为代理波动，8min 后 half-open 再试一次） */
const REACTIVE_COOLDOWN_MS = 8 * 60_000
/** 探活失败驱动的熔断冷却时长（略长于探活间隔窗口，覆盖到下一轮探活确认前） */
const PROBE_COOLDOWN_MS = 12 * 60_000

/**
 * 硬代理错误：传输/认证层，几乎可确定是代理本身的问题（非目标站问题）。
 * ⚠️ 有意区别于 click-brush 的 TRANSIENT_PROXY_ERR：此处**不含 timeout**——慢目标站也会超时，
 * 若把 timeout 计入会误伤健康代理。只对确定性的代理故障信号熔断。
 */
export const PROXY_HARD_ERR =
  /socks5 authentication failed|rejected by the socks5 server|econnrefused|econnreset|socket hang up|tunneling socket could not be established/i

interface Breaker {
  /** 连续硬失败计数（成功清零 = 删除条目） */
  fails: number
  /** 熔断到期时间戳（ms）；> now 即处于 open 状态 */
  openUntil: number
}

const breakers = new Map<string, Breaker>()

/** 该供应商当前是否处于熔断（open）中。 */
export function isProviderOpen(id: string): boolean {
  const b = breakers.get(id)
  return b ? b.openUntil > Date.now() : false
}

/**
 * 从候选（须按 priority 升序）中选一个「未熔断」的供应商：
 *  - 有健康（未 open / 已 half-open）的 → 返回优先级最高的那个；
 *  - 全部 open → 返回 openUntil 最小（最快恢复）者，尽力而为不停摆；
 *  - 候选为空 → null。
 */
export function selectHealthy<T extends { id: bigint }>(candidates: T[]): T | null {
  if (candidates.length === 0) return null
  const now = Date.now()
  for (const c of candidates) {
    const b = breakers.get(c.id.toString())
    if (!b || b.openUntil <= now) return c
  }
  // 全部熔断中：挑最快恢复者
  let best = candidates[0]
  let bestUntil = breakers.get(best.id.toString())?.openUntil ?? 0
  for (const c of candidates) {
    const until = breakers.get(c.id.toString())?.openUntil ?? 0
    if (until < bestUntil) {
      best = c
      bestUntil = until
    }
  }
  return best
}

/**
 * 上报一次供应商使用结果（reactive 路径，B）。
 *  - ok：清除熔断与计数（供应商健康）。
 *  - 失败：连续计数 +1，达阈值即 open 冷却 REACTIVE_COOLDOWN_MS；已 open 期间的失败会续期。
 * 注意：仅应在「硬代理错误」时以 ok=false 调用（调用方用 PROXY_HARD_ERR 判定）。
 */
export function reportProviderResult(id: string, ok: boolean): void {
  if (!id) return
  if (ok) {
    breakers.delete(id)
    return
  }
  const b = breakers.get(id) ?? { fails: 0, openUntil: 0 }
  b.fails += 1
  if (b.fails >= FAIL_THRESHOLD) {
    b.openUntil = Date.now() + REACTIVE_COOLDOWN_MS
    console.warn(`[proxy-circuit] provider ${id} 连续硬失败 ${b.fails} 次，熔断 ${REACTIVE_COOLDOWN_MS / 60000}min`)
  }
  breakers.set(id, b)
}

/** 探活失败：直接熔断（探活是确定性信号，A 路径）。冷却取现有与新值的较大者。 */
export function openProvider(id: string, ms = PROBE_COOLDOWN_MS): void {
  if (!id) return
  const b = breakers.get(id) ?? { fails: 0, openUntil: 0 }
  b.openUntil = Math.max(b.openUntil, Date.now() + ms)
  breakers.set(id, b)
  console.warn(`[proxy-circuit] provider ${id} 探活失败，熔断 ${ms / 60000}min`)
}

/** 探活成功 / 真实成功：清除熔断（A 路径的 healthy 分支）。 */
export function clearProvider(id: string): void {
  if (id) breakers.delete(id)
}