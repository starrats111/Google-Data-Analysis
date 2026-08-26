/**
 * TnbProxy 动态住宅流量余额监控（D-280，对齐 kookeey-quota 的「快用完就提醒」能力）
 *
 * TnbProxy（dash.tnbproxy.com，Thordata 白标）无公开 API 文档，接口为拆解其
 * 仪表盘前端实测得出（2026-08-22 生产服务器验证通过）：
 *   POST https://server.tnbproxy.com/api/plan/advanced_traffic
 *   头   X-Dev-Token: <后台「API 访问安全」的 Access key>
 *   响应 { code:0, data:{ cumulative_usage_bytes, remaining_bytes, ... } }
 * 「advanced traffic」即我们买的按流量动态住宅套餐（500GB）；字节按十进制 1GB=1e9
 * 换算，与 TnbProxy 后台展示口径一致。
 *
 * 凭据：system_configs(tnbproxy_api_key)，AES 加密存储（crypto.ts 密文格式）→ 环境变量兜底。
 * 阈值：system_configs(tnbproxy_traffic_alert_gb) → 默认 20(GB)，与 kookeey 同基准。
 */

import { prisma } from '@/lib/prisma'
import { decryptPassword } from '@/lib/crypto'

const TNB_QUOTA_URL = 'https://server.tnbproxy.com/api/plan/advanced_traffic'
const BYTES_PER_GB = 1e9 // 十进制口径，与 TnbProxy 后台一致
export const DEFAULT_TNB_ALERT_GB = 20

export interface TnbTrafficReport {
  ok: boolean
  message: string
  thresholdGB: number
  remainingGB: number | null
  usedGB: number | null
  /** 剩余 ≤ 阈值（仅 ok 时有意义） */
  low: boolean
  checkedAt: string
}

/** 解析 TnbProxy plan/advanced_traffic 响应（纯函数，单测锁三态：成功/业务错误/结构不符）。 */
export function parseTnbQuotaResponse(
  json: unknown,
): { ok: true; remainingBytes: number; usedBytes: number } | { ok: false; message: string } {
  const j = json as { code?: number; message?: string; error?: string; data?: Record<string, unknown> } | null
  if (!j || typeof j !== 'object') return { ok: false, message: 'TnbProxy API 返回非 JSON 对象' }
  if (j.code !== 0) return { ok: false, message: `TnbProxy API 业务错误：code=${j.code} ${j.error || j.message || ''}`.trim() }
  const remaining = Number(j.data?.remaining_bytes)
  const used = Number(j.data?.cumulative_usage_bytes)
  if (!Number.isFinite(remaining)) return { ok: false, message: 'TnbProxy API 响应缺少 remaining_bytes' }
  return { ok: true, remainingBytes: remaining, usedBytes: Number.isFinite(used) ? used : 0 }
}

async function readConfig(): Promise<{ apiKey: string; thresholdGB: number } | null> {
  const rows = await prisma.system_configs.findMany({
    where: { config_key: { in: ['tnbproxy_api_key', 'tnbproxy_traffic_alert_gb'] }, is_deleted: 0 },
    select: { config_key: true, config_value: true },
  })
  const map = new Map(rows.map((r) => [r.config_key, r.config_value ?? '']))
  const rawKey = (map.get('tnbproxy_api_key') || process.env.TNBPROXY_API_KEY || '').trim()
  const apiKey = rawKey ? decryptPassword(rawKey) : ''
  const thGB = Number(map.get('tnbproxy_traffic_alert_gb') || process.env.TNBPROXY_TRAFFIC_ALERT_GB || DEFAULT_TNB_ALERT_GB)
  if (!apiKey) return null
  return { apiKey, thresholdGB: Number.isFinite(thGB) && thGB > 0 ? thGB : DEFAULT_TNB_ALERT_GB }
}

/** 查询 TnbProxy 剩余流量。凭据缺失/请求失败返回 ok:false（不抛错，调用方按未接入处理）。 */
export async function checkTnbTraffic(): Promise<TnbTrafficReport> {
  const checkedAt = new Date().toISOString()
  const cfg = await readConfig()
  if (!cfg) {
    return { ok: false, message: '未配置 TnbProxy API key（system_configs.tnbproxy_api_key）', thresholdGB: DEFAULT_TNB_ALERT_GB, remainingGB: null, usedGB: null, low: false, checkedAt }
  }

  let json: unknown
  try {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), 15000)
    const resp = await fetch(TNB_QUOTA_URL, {
      method: 'POST',
      headers: { 'X-Dev-Token': cfg.apiKey, 'Content-Type': 'application/json' },
      body: '{}',
      signal: controller.signal,
    })
    clearTimeout(timer)
    json = await resp.json()
  } catch (e) {
    return { ok: false, message: `请求 TnbProxy API 失败：${e instanceof Error ? e.message : String(e)}`, thresholdGB: cfg.thresholdGB, remainingGB: null, usedGB: null, low: false, checkedAt }
  }

  const parsed = parseTnbQuotaResponse(json)
  if (!parsed.ok) {
    return { ok: false, message: parsed.message, thresholdGB: cfg.thresholdGB, remainingGB: null, usedGB: null, low: false, checkedAt }
  }

  const remainingGB = Math.round((parsed.remainingBytes / BYTES_PER_GB) * 100) / 100
  const usedGB = Math.round((parsed.usedBytes / BYTES_PER_GB) * 100) / 100
  return { ok: true, message: 'ok', thresholdGB: cfg.thresholdGB, remainingGB, usedGB, low: remainingGB <= cfg.thresholdGB, checkedAt }
}

// 带缓存的取数：代理管理页每次刷新都要用，缓存避免频繁外呼。仅缓存成功结果。
let _cache: { at: number; report: TnbTrafficReport } | null = null
const CACHE_TTL_MS = 10 * 60 * 1000

/** 查询 TnbProxy 剩余流量（默认 10 分钟缓存）。 */
export async function getTnbTrafficCached(ttlMs = CACHE_TTL_MS): Promise<TnbTrafficReport> {
  if (_cache && Date.now() - _cache.at < ttlMs) return _cache.report
  const report = await checkTnbTraffic()
  if (report.ok) _cache = { at: Date.now(), report }
  return report
}
