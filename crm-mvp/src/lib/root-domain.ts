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
/**
 * D-317：取商家域的「品牌段」，供证据页归属校验做正文比对用。
 *
 * 与 `landingMatchesTarget` 内部用的是同一个口径（根域第一段、去掉非字母数字、小写），
 * 单独导出是因为归属校验除了比 host 还要在正文里找这个词。
 * 短于 3 字符返回空串 —— 拿两三个字母去正文里搜必然满地误报。
 */
export function brandTokenOf(targetDomain: string | null | undefined): string {
  if (!targetDomain) return ''
  const brand = (extractRootDomain(targetDomain) || '')
    .split('.')[0]
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '')
  if (brand.length < 3) return ''
  // 商家 URL 本身就填成建站平台子域时（库里确有 `e6026e.myshopify.com` 这类），
  // 根域第一段取出来的是平台名而不是品牌名。拿「myshopify」去商家正文里搜必然搜不到，
  // 会把归属校验变成误杀机。这种情况直接判为「取不出品牌段」，不参与判定。
  if (PLATFORM_ROOTS.has(brand)) return ''
  return brand
}

/** 建站/托管平台的根域第一段——它们出现在这里代表「没填真品牌域」，不是品牌名 */
const PLATFORM_ROOTS = new Set([
  'myshopify', 'shopify', 'squarespace', 'wixsite', 'wix', 'weebly',
  'bigcartel', 'webflow', 'webnode', 'shoplazza', 'shopline', 'shoplineapp',
  'ecwid', 'storenvy', 'bigcommerce', 'mybigcommerce', 'godaddysites',
  'netlify', 'vercel', 'github', 'pages', 'herokuapp', 'blogspot', 'wordpress',
])

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
  return labels.some(
    (l) => l.includes(brand) || brand.includes(l) || sharedPrefixLen(l, brand) >= SAME_ENTITY_PREFIX,
  )
}

/**
 * D-318：同主体的第二判据——两个品牌段共享足够长的前缀。
 *
 * 单靠「互相包含」漏掉了商家自己的姊妹域：`easycanvasdesigns.com` 与 `easycanvasprints.com`
 * 谁也不包含谁，D-316 上线当天就把它判成了「停在第三方中转域名」，tracking_status 从 ok
 * 掉成 resolve_failed，连追踪后缀一起丢了（2026-09-05 20:31 生产日志实证，商家实为
 * Easy Canvas Prints™ 的另一个域）。
 *
 * 阈值取 10 个字符里的 6：真中转域与商家名毫无字面关系（adt212/tchibo=0、tatrck/tchibo=1、
 * kelkoogroup/miliboo=0、provenpixel/knix=0、pepperjamnetwork/mohawkgeneralstore=0），
 * 留出的余量足够；而误判方向是「放行一个其实无关的域」，与本模块一贯的
 * 「宁可漏判，不可错杀」一致。
 */
const SAME_ENTITY_PREFIX = 6

function sharedPrefixLen(a: string, b: string): number {
  const n = Math.min(a.length, b.length)
  let i = 0
  while (i < n && a[i] === b[i]) i++
  return i
}
