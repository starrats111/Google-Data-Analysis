/**
 * 根域名（registrable domain）提取与比对。
 *
 * D-177（采纳 kyads verify-link 的「域名匹配」判定思想）：换链接跟链拿不到追踪参数时，
 * 用「落地页根域名 == 商家官网根域名」区分——匹配 = 链接活着（只是需要浏览器执行 JS /
 * 参数被吃），不匹配才是疑似死链。简化版二级 TLD 表足够覆盖联盟商家的常见国别域名。
 */

const SECOND_LEVEL_TLD = new Set([
  'co.uk', 'co.jp', 'co.kr', 'co.in', 'co.nz', 'co.za', 'co.id', 'co.th', 'co.il',
  'com.au', 'com.br', 'com.mx', 'com.sg', 'com.hk', 'com.tw', 'com.tr', 'com.cn',
  'com.ar', 'com.co', 'com.pe', 'com.ph', 'com.my', 'com.vn',
  'ne.jp', 'or.jp', 'ac.uk', 'gov.uk', 'org.uk',
])

/** 从 URL / 裸域名提取根域名（小写、去 www）。解析失败返回 null。 */
export function extractRootDomain(input: string | null | undefined): string | null {
  if (!input || typeof input !== 'string') return null
  let host = input.trim().toLowerCase()
  if (!host) return null
  try {
    if (host.includes('://')) host = new URL(host).hostname
    else if (host.includes('/')) host = host.split('/')[0]
  } catch {
    return null
  }
  if (host.startsWith('www.')) host = host.slice(4)
  if (host.includes(':')) host = host.split(':')[0]
  const parts = host.split('.').filter(Boolean)
  if (parts.length < 2) return host || null
  const lastTwo = parts.slice(-2).join('.')
  if (parts.length >= 3 && SECOND_LEVEL_TLD.has(lastTwo)) {
    return parts.slice(-3).join('.')
  }
  return lastTwo
}

/** 两个 URL/域名的根域名是否一致（任一解析失败返回 false）。 */
export function sameRootDomain(a: string | null | undefined, b: string | null | undefined): boolean {
  const ra = extractRootDomain(a)
  const rb = extractRootDomain(b)
  return !!ra && !!rb && ra === rb
}
