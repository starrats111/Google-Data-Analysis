/**
 * kylink（换链接系统）HTTP 客户端
 *
 * CRM 通过用户个人的 kylink API Key 调用 kylink 对外接口：
 * - 测试连接（GET /api/v1/me）
 * - 读取「未配置」广告系列（GET /api/v1/affiliate-links/missing）
 * - 回填联盟链接（POST /api/v1/affiliate-links/inbound）
 * - 回写每日统计（POST /api/v1/crm-integration/report）
 *
 * 基址由 KYLINK_BASE_URL 控制，默认 https://xc.kyads.net。
 */

const DEFAULT_BASE_URL = 'https://xc.kyads.net'
const DEFAULT_TIMEOUT_MS = 15000

export function getKylinkBaseUrl(): string {
  return (process.env.KYLINK_BASE_URL || DEFAULT_BASE_URL).replace(/\/+$/, '')
}

export interface KylinkUser {
  id: string
  email: string | null
  name: string | null
  role: string
  status: string
}

export interface KylinkMissingCampaign {
  campaignId: string
  campaignName: string | null
  country: string | null
  finalUrl: string | null
}

export interface InboundPayload {
  campaignId: string
  affiliateLink: string
  country: string
  campaignName?: string
}

interface KylinkErrorShape {
  success?: boolean
  error?: { code?: string; message?: string }
}

export class KylinkApiError extends Error {
  status: number
  code: string
  constructor(message: string, status: number, code = 'KYLINK_ERROR') {
    super(message)
    this.name = 'KylinkApiError'
    this.status = status
    this.code = code
  }
}

async function kylinkFetch<T>(
  apiKey: string,
  path: string,
  init?: { method?: string; body?: unknown; timeoutMs?: number }
): Promise<T> {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), init?.timeoutMs ?? DEFAULT_TIMEOUT_MS)
  try {
    const res = await fetch(`${getKylinkBaseUrl()}${path}`, {
      method: init?.method ?? 'GET',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        ...(init?.body ? { 'Content-Type': 'application/json' } : {}),
      },
      body: init?.body ? JSON.stringify(init.body) : undefined,
      signal: controller.signal,
      cache: 'no-store',
    })

    const text = await res.text()
    let json: unknown = null
    try {
      json = text ? JSON.parse(text) : null
    } catch {
      json = null
    }

    if (!res.ok) {
      const err = (json as KylinkErrorShape | null)?.error
      throw new KylinkApiError(
        err?.message || `kylink 请求失败（HTTP ${res.status}）`,
        res.status,
        err?.code || 'KYLINK_HTTP_ERROR'
      )
    }

    return json as T
  } catch (e) {
    if (e instanceof KylinkApiError) throw e
    if (e instanceof Error && e.name === 'AbortError') {
      throw new KylinkApiError('kylink 请求超时', 504, 'KYLINK_TIMEOUT')
    }
    throw new KylinkApiError(
      e instanceof Error ? e.message : 'kylink 连接失败',
      502,
      'KYLINK_NETWORK_ERROR'
    )
  } finally {
    clearTimeout(timeout)
  }
}

/** 测试连接：返回 API Key 对应的 kylink 用户 */
export async function pingKylink(apiKey: string): Promise<KylinkUser> {
  const res = await kylinkFetch<{ success: boolean; user: KylinkUser }>(apiKey, '/api/v1/me')
  return res.user
}

/** 读取当前用户「未配置联盟链接」的广告系列 */
export async function listMissingCampaigns(apiKey: string): Promise<KylinkMissingCampaign[]> {
  const res = await kylinkFetch<{ success: boolean; campaigns: KylinkMissingCampaign[] }>(
    apiKey,
    '/api/v1/affiliate-links/missing'
  )
  return res.campaigns ?? []
}

/** 推送（回填）单条联盟链接到 kylink */
export async function pushInboundAffiliateLink(
  apiKey: string,
  payload: InboundPayload
): Promise<{ status: 'applied' | 'pending' }> {
  const res = await kylinkFetch<{ success: boolean; status: 'applied' | 'pending' }>(
    apiKey,
    '/api/v1/affiliate-links/inbound',
    { method: 'POST', body: payload }
  )
  return { status: res.status }
}

/** 回写本次同步的成功/失败统计 */
export async function reportSyncStats(
  apiKey: string,
  stats: { success: number; failed: number }
): Promise<void> {
  await kylinkFetch(apiKey, '/api/v1/crm-integration/report', {
    method: 'POST',
    body: stats,
  })
}
