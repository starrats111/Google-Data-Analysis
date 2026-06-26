/**
 * 换链接代理供应商（移植自 kylink proxy-selector，适配 CRM kyads_proxies 表）
 *
 * 模型：kyads_proxies 一行 = 一个住宅代理供应商（host:port + username_template + password +
 * country_code_map），按国家把模板里的 {COUNTRY}/{session:N} 等占位替换成实际值，组装出
 * 带认证的代理 URL（默认 socks5）。kyads_proxy_users 记录「供应商 → 用户」分配关系。
 *
 * 换链接引擎（affiliate-link-resolver → crawl-proxy.getProxyUrlForCountry）优先用本模块取代理，
 * 取不到再兜底 system_config 的 crawl_proxy_template。
 */
import { prisma } from '@/lib/prisma'
import { fetchViaProxy } from '@/lib/crawl-proxy'

// ── 用户名模板占位替换 ──────────────────────────────────────────

export type CountryCodeMap = Record<string, string> | null | undefined

function generateRandom(length: number): string {
  const chars = 'abcdefghijklmnopqrstuvwxyz0123456789'
  let out = ''
  for (let i = 0; i < length; i++) out += chars.charAt(Math.floor(Math.random() * chars.length))
  return out
}
function generateRandomDigits(length: number): string {
  let out = ''
  for (let i = 0; i < length; i++) out += Math.floor(Math.random() * 10).toString()
  return out
}

/** ISO → 代理供应商常见别名（GB→UK）。countryCodeMap 优先于此默认映射。 */
export function toProxyCountryCode(isoCode: string): string {
  const upper = isoCode.toUpperCase()
  if (upper === 'GB') return 'UK'
  return upper
}

/**
 * 用户名模板占位替换。支持：
 * {COUNTRY}/{country}（映射后代码）、{COUNTRY_ISO}/{country_iso}（原始 ISO）、
 * {random:N}（N 位字母数字）、{session:N}（N 位纯数字，会话标识）、`**`（兼容旧模板=国家代码）
 */
export function processUsernameTemplate(
  template: string,
  countryCode: string,
  countryCodeMap?: CountryCodeMap,
): string {
  if (!template) return ''
  const upper = countryCode.toUpperCase()
  const proxyCode = countryCodeMap && countryCodeMap[upper] ? countryCodeMap[upper] : toProxyCountryCode(upper)
  return template
    .replace(/\{COUNTRY\}/g, proxyCode.toUpperCase())
    .replace(/\{country\}/g, proxyCode.toLowerCase())
    .replace(/\{COUNTRY_ISO\}/g, upper)
    .replace(/\{country_iso\}/g, countryCode.toLowerCase())
    .replace(/\{random:(\d+)\}/gi, (_, len) => generateRandom(parseInt(len, 10)))
    .replace(/\{session:(\d+)\}/gi, (_, len) => generateRandomDigits(parseInt(len, 10)))
    .replace(/\*\*/g, proxyCode.toUpperCase())
}

// ── 供应商选择 ──────────────────────────────────────────────────

export interface ProviderRow {
  id: bigint
  name: string
  host: string
  port: number
  proxy_type: string
  priority: number
  username_template: string | null
  password: string | null
  country_code_map: unknown
}

const PROVIDER_SELECT = {
  id: true,
  name: true,
  host: true,
  port: true,
  proxy_type: true,
  priority: true,
  username_template: true,
  password: true,
  country_code_map: true,
} as const

/**
 * 选取一个可用代理供应商：active + 未删除，按 priority 升序。
 * 传 userId 时优先取分配给该用户的供应商；该用户无专属分配则回退全局可用供应商。
 */
export async function pickProvider(userId?: bigint | null): Promise<ProviderRow | null> {
  if (userId && userId > BigInt(0)) {
    const bindings = await prisma.kyads_proxy_users.findMany({
      where: { user_id: userId },
      select: { proxy_id: true },
    })
    const ids = bindings.map((b) => b.proxy_id)
    if (ids.length > 0) {
      const assigned = await prisma.kyads_proxies.findFirst({
        where: { id: { in: ids }, status: 'active', is_deleted: 0 },
        orderBy: { priority: 'asc' },
        select: PROVIDER_SELECT,
      })
      if (assigned) return assigned
    }
  }
  return prisma.kyads_proxies.findFirst({
    where: { status: 'active', is_deleted: 0 },
    orderBy: { priority: 'asc' },
    select: PROVIDER_SELECT,
  })
}

/** 用供应商 + 国家组装带认证的代理 URL（默认 socks5；http/https 按 proxy_type）。 */
export function buildProviderProxyUrl(provider: ProviderRow, country: string): string {
  const proto = (provider.proxy_type || 'socks5').toLowerCase()
  const map = (provider.country_code_map || null) as CountryCodeMap
  const username = processUsernameTemplate(provider.username_template || '', country, map)
  const password = provider.password || ''
  const auth = username || password ? `${encodeURIComponent(username)}:${encodeURIComponent(password)}@` : ''
  return `${proto}://${auth}${provider.host}:${provider.port}`
}

/**
 * 取一个供应商代理 URL（换链接引擎用）。无可用供应商返回 null（上层兜底模板）。
 */
export async function getProviderProxyUrl(
  country: string,
  opts: { userId?: bigint | null } = {},
): Promise<string | null> {
  if (!country) return null
  try {
    const provider = await pickProvider(opts.userId)
    if (!provider) return null
    return buildProviderProxyUrl(provider, country)
  } catch (e) {
    console.warn('[proxy-provider] getProviderProxyUrl error:', e instanceof Error ? e.message : e)
    return null
  }
}

// ── 出口 IP 测试（后台「测试」按钮用）────────────────────────────

export interface ExitIpResult {
  ok: boolean
  message: string
  exitIp?: string
  exitCountry?: string
  latencyMs?: number
  proxyUrl?: string
}

/** 通过指定供应商代理访问 ipinfo.io 探出口 IP/国家。 */
export async function testProviderExitIp(providerId: bigint, country: string): Promise<ExitIpResult> {
  const provider = await prisma.kyads_proxies.findFirst({
    where: { id: providerId, is_deleted: 0 },
    select: PROVIDER_SELECT,
  })
  if (!provider) return { ok: false, message: '供应商不存在' }

  const cc = (country || 'US').toUpperCase()
  const proxyUrl = buildProviderProxyUrl(provider, cc)
  const masked = proxyUrl.replace(/\/\/[^@]*@/, '//***:***@')
  const started = Date.now()
  try {
    const resp = await Promise.race([
      fetchViaProxy('https://ipinfo.io/json', {}, proxyUrl, 3),
      new Promise<never>((_, rej) => setTimeout(() => rej(new Error('测试超时(>15s)')), 15000)),
    ])
    if (!resp.ok) return { ok: false, message: `代理返回 HTTP ${resp.status}`, proxyUrl: masked }
    const json = JSON.parse(await resp.text()) as { ip?: string; country?: string }
    if (!json.ip) return { ok: false, message: 'ipinfo 响应缺少 ip 字段', proxyUrl: masked }
    const exitCountry = (json.country || '').toUpperCase()
    const match = exitCountry === cc || ((exitCountry === 'GB' || exitCountry === 'UK') && (cc === 'GB' || cc === 'UK'))
    return {
      ok: true,
      message: match ? `出口 IP 正常（${exitCountry}）` : `出口 IP 国家 ${exitCountry} 与目标 ${cc} 不一致`,
      exitIp: json.ip,
      exitCountry,
      latencyMs: Date.now() - started,
      proxyUrl: masked,
    }
  } catch (e) {
    return { ok: false, message: e instanceof Error ? e.message : '测试失败', proxyUrl: masked }
  }
}
