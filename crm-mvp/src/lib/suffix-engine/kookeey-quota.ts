/**
 * kookeey 动态住宅流量余额监控（治「代理流量耗尽只能等换链接报错才发现」）
 *
 * 探活（proxy-health）只能测「通/不通」，测不出「还剩多少流量」——等到流量耗尽、
 * SOCKS5 认证开始失败时，换链接补货已经断供。本模块通过 kookeey 开放 API 主动查询
 * 子账户的剩余动态住宅流量，剩余 ≤ 阈值（默认 5GB）时提前告警，做到「快用完就提醒」。
 *
 * kookeey API：
 *   - 路径 https://www.kookeey.com/clientapi/<method>
 *   - 固定参数 accessid / signature / ts；signature = base64( hex( HMAC-SHA1(token, 参数串) ) )
 *     参数串顺序需与 URL 参数顺序一致，形如 `page=1&page_size=50&ts=<秒级时间戳>`。
 *   - /subaccounts 返回每个子账户的 traffic_left（动态住宅流量余额，单位 MB）与 expire_time。
 *
 * 凭据来源（优先级）：system_configs(kookeey_api_accessid / kookeey_api_token) → 环境变量。
 * 阈值：system_configs(kookeey_traffic_alert_gb) → 默认 5(GB)。
 */

import crypto from 'node:crypto'
import { prisma } from '@/lib/prisma'

const KOOKEEY_API_BASE = 'https://www.kookeey.com/clientapi'
const MB_PER_GB = 1024
export const DEFAULT_TRAFFIC_ALERT_GB = 5

export interface KookeeySubAccount {
  uid: number
  authname: string
  name: string
  status: number // 1 有效，2 已删除，3 已失效
  trafficLeftMB: number
  trafficLeftGB: number
  expireTime: number | null // 动态住宅流量到期（unix 秒）
}

export interface KookeeyTrafficReport {
  ok: boolean
  message: string
  thresholdGB: number
  subAccounts: KookeeySubAccount[]
  low: KookeeySubAccount[] // status=1 且剩余 <= 阈值
  checkedAt: string
}

async function readConfig(): Promise<{ accessid: string; token: string; thresholdGB: number } | null> {
  const rows = await prisma.system_configs.findMany({
    where: {
      config_key: { in: ['kookeey_api_accessid', 'kookeey_api_token', 'kookeey_traffic_alert_gb'] },
      is_deleted: 0,
    },
    select: { config_key: true, config_value: true },
  })
  const map = new Map(rows.map((r) => [r.config_key, r.config_value ?? '']))
  const accessid = (map.get('kookeey_api_accessid') || process.env.KOOKEEY_ACCESSID || '').trim()
  const token = (map.get('kookeey_api_token') || process.env.KOOKEEY_API_TOKEN || '').trim()
  const thGB = Number(map.get('kookeey_traffic_alert_gb') || process.env.KOOKEEY_TRAFFIC_ALERT_GB || DEFAULT_TRAFFIC_ALERT_GB)
  if (!accessid || !token) return null
  return { accessid, token, thresholdGB: Number.isFinite(thGB) && thGB > 0 ? thGB : DEFAULT_TRAFFIC_ALERT_GB }
}

function sign(token: string, paramStr: string): string {
  const hex = crypto.createHmac('sha1', token).update(paramStr).digest('hex')
  return Buffer.from(hex, 'utf8').toString('base64')
}

/** 查询 kookeey 子账户剩余流量。凭据缺失时返回 ok:false（不报错，仅跳过）。 */
export async function checkKookeeyTraffic(): Promise<KookeeyTrafficReport> {
  const checkedAt = new Date().toISOString()
  const cfg = await readConfig()
  if (!cfg) {
    return { ok: false, message: '未配置 kookeey API 凭据（system_configs.kookeey_api_accessid / kookeey_api_token）', thresholdGB: DEFAULT_TRAFFIC_ALERT_GB, subAccounts: [], low: [], checkedAt }
  }

  const ts = Math.floor(Date.now() / 1000)
  const extra = 'page=1&page_size=50'
  const paramStr = `${extra}&ts=${ts}`
  const signature = sign(cfg.token, paramStr)
  const url = `${KOOKEEY_API_BASE}/subaccounts?accessid=${encodeURIComponent(cfg.accessid)}&signature=${encodeURIComponent(signature)}&${extra}&ts=${ts}`

  let json: unknown
  try {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), 15000)
    const resp = await fetch(url, { method: 'GET', signal: controller.signal })
    clearTimeout(timer)
    json = await resp.json()
  } catch (e) {
    return { ok: false, message: `请求 kookeey API 失败：${e instanceof Error ? e.message : String(e)}`, thresholdGB: cfg.thresholdGB, subAccounts: [], low: [], checkedAt }
  }

  const j = json as { success?: boolean; code?: number; msg?: string; data?: { list?: Array<Record<string, unknown>> } }
  if (!j || j.success !== true || !j.data || !Array.isArray(j.data.list)) {
    return { ok: false, message: `kookeey API 返回异常：code=${j?.code} msg=${j?.msg}`, thresholdGB: cfg.thresholdGB, subAccounts: [], low: [], checkedAt }
  }

  const subAccounts: KookeeySubAccount[] = j.data.list.map((s) => {
    const mb = Number(s.traffic_left) || 0
    return {
      uid: Number(s.uid) || 0,
      authname: String(s.authname ?? ''),
      name: String(s.name ?? ''),
      status: Number(s.status) || 0,
      trafficLeftMB: mb,
      trafficLeftGB: Math.round((mb / MB_PER_GB) * 100) / 100,
      expireTime: s.expire_time ? Number(s.expire_time) : null,
    }
  })

  const low = subAccounts.filter((s) => s.status === 1 && s.trafficLeftGB <= cfg.thresholdGB)

  return { ok: true, message: 'ok', thresholdGB: cfg.thresholdGB, subAccounts, low, checkedAt }
}

// 带缓存的取数：换链接页面/overview 接口每次刷新都要用，缓存避免频繁外呼 kookeey API。
let _cache: { at: number; report: KookeeyTrafficReport } | null = null
const CACHE_TTL_MS = 10 * 60 * 1000

/** 查询 kookeey 剩余流量（默认 10 分钟缓存）。仅缓存成功结果，失败下次重试。 */
export async function getKookeeyTrafficCached(ttlMs = CACHE_TTL_MS): Promise<KookeeyTrafficReport> {
  if (_cache && Date.now() - _cache.at < ttlMs) return _cache.report
  const report = await checkKookeeyTraffic()
  if (report.ok) _cache = { at: Date.now(), report }
  return report
}
