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

/**
 * D-316：落地 host 与商家域是否属于「同一个主体」——比同根域宽一档的品牌级比对。
 *
 * 用途是把「第三方中转站」和「商家自己的另一个域名」区分开。刻意放过三类正常情况，只揪中转：
 *   · 同根域：      `shop.brand.com`         vs `brand.com` → 过
 *   · 换 ccTLD：    `brand.co.uk`            vs `brand.com` → 过（品牌段相同）
 *   · 建站平台子域：`brand.myshopify.com`    vs `brand.com` → 过（品牌段出现在 host 里）
 *   · 第三方中转：  `fatcoupon.com`          vs `bellamiacollections.com` → 拦
 *
 * 比对方式：取商家域的品牌段，与落地 host「去掉公共后缀之后」的每一段做互相包含判断。
 * 只比根域第一段是不够的——`brand.myshopify.com` 的根域是 `myshopify.com`，第一段会变成
 * `myshopify`，商家自己的品牌段反而被丢掉，导致 Shopify 托管的商家被误拦。
 *
 * 这道闸的取向是「宁可漏判，不可错杀」：品牌段短于 3 字符时一律放行。
 */
export function landingMatchesTarget(landingHost: string, targetDomain: string): boolean {
  if (sameRootDomain(landingHost, targetDomain)) return true
  const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, '')
  const brand = norm((extractRootDomain(targetDomain) || '').split('.')[0])
  if (brand.length < 3) return true
  // 两种入参都要认：裸 host（resolver 侧）与完整 URL（生成侧的 final_url）
  let host = (landingHost || '').trim().toLowerCase()
  try {
    if (host.includes('://')) host = new URL(host).hostname
    else if (host.includes('/')) host = host.split('/')[0]
  } catch {
    return true
  }
  if (host.includes(':')) host = host.split(':')[0]
  const rootParts = (extractRootDomain(host) || '').split('.').filter(Boolean)
  const suffixLen = Math.max(rootParts.length - 1, 1)
  const hostParts = host.split('.').filter(Boolean)
  const labels = hostParts
    .slice(0, Math.max(hostParts.length - suffixLen, 0))
    .map(norm)
    .filter((l) => l.length >= 3)
  // 落地 host 压根解析不出可比对的段（空串、裸 TLD、畸形输入）→ 放行，不拿解析失败当证据
  if (labels.length === 0) return true
  return labels.some((l) => l.includes(brand) || brand.includes(l))
}
