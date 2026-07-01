/**
 * 换链接代理主动健康探活（治「代理到期/失效只能等生成报错才发现」的痛点）
 *
 * 背景：换链接补货优先用 kyads_proxies 里的住宅代理供应商（kookeey/cliproxy 等）。这些代理按
 * 流量/订阅计费，额度耗尽或到期后网关会直接拒绝 SOCKS5 认证。此前系统只能等补货大面积
 * 失败、告警堆积后才被动发现（如 2026-06-28~29 三家代理配额耗尽，换链接静默失败两天）。
 *
 * 本模块定期对每个 active 供应商做一次「探出口 IP」探活：
 *   - 认证通过且拿到出口 IP → 健康
 *   - SOCKS5 认证失败 / 连接被断 / 超时 → 判为不可用（疑似到期/配额耗尽/凭据失效）
 * 探活结果交由 /api/cron/proxy-health 转成 admin 通知，做到「到期即提醒」而非「等报错」。
 */

import { prisma } from '@/lib/prisma'
import { testProviderExitIp } from './proxy-provider'

/** 探活用的金丝雀国家（三家住宅代理均支持 US 出口，作统一探活基准） */
const CANARY_COUNTRY = 'US'
/** 单个供应商探活最多重试次数（降低瞬时抖动误报） */
const PROBE_ATTEMPTS = 2

export interface ProviderHealth {
  id: string
  name: string
  host: string
  port: number
  ok: boolean
  message: string
  exitIp?: string | null
  latencyMs?: number
}

export interface ProxyHealthReport {
  activeCount: number
  healthy: ProviderHealth[]
  failed: ProviderHealth[]
  checkedAt: string
}

/**
 * 对所有 active 代理供应商逐个探活。串行执行（低配机 + 避免同时多条 SOCKS 连接）。
 */
export async function checkAllProxiesHealth(): Promise<ProxyHealthReport> {
  const providers = await prisma.kyads_proxies.findMany({
    where: { status: 'active', is_deleted: 0 },
    select: { id: true, name: true, host: true, port: true },
    orderBy: { priority: 'asc' },
  })

  const healthy: ProviderHealth[] = []
  const failed: ProviderHealth[] = []

  for (const p of providers) {
    let last: ProviderHealth = {
      id: p.id.toString(),
      name: p.name,
      host: p.host,
      port: p.port,
      ok: false,
      message: '未探活',
    }
    for (let attempt = 0; attempt < PROBE_ATTEMPTS; attempt++) {
      try {
        const r = await testProviderExitIp(p.id, CANARY_COUNTRY)
        last = {
          id: p.id.toString(),
          name: p.name,
          host: p.host,
          port: p.port,
          ok: r.ok,
          message: r.message,
          exitIp: r.exitIp ?? null,
          latencyMs: r.latencyMs,
        }
      } catch (e) {
        last = { ...last, ok: false, message: e instanceof Error ? e.message : String(e) }
      }
      if (last.ok) break
    }
    if (last.ok) healthy.push(last)
    else failed.push(last)
  }

  return {
    activeCount: providers.length,
    healthy,
    failed,
    checkedAt: new Date().toISOString(),
  }
}
