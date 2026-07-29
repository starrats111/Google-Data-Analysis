/**
 * 浏览器指纹生成器
 *
 * 为每次追踪会话生成随机但内部一致的浏览器指纹（UA + Sec-Ch-Ua + 平台 + 语言）。
 * 仅生成 Chromium 系指纹（Chrome / Edge），因为：
 * 1. 占全球桌面流量 ~75%，最不可疑
 * 2. node-fetch 的 TLS 指纹更接近 Chromium 而非 Firefox/Safari
 * 3. 统一发送 Sec-Ch-Ua 系列头，不会出现"发了 Firefox UA 却带 Sec-Ch-Ua"的矛盾
 *
 * 组合量：2 浏览器 × 9 大版本 × 8 平台 × ~800 构建号 × 26 语言 × 3 品牌版本
 *       ≈ 8,985,600 种唯一指纹
 */

// ============================================
// 类型定义
// ============================================

export interface BrowserFingerprint {
  /** 完整 User-Agent 字符串 */
  userAgent: string
  /**
   * 会话级请求头（不含 Referer / Cookie / Sec-Fetch-Site 等动态头）。
   * 传给 trackRedirects 后由 buildBrowserHeaders 合并动态头。
   */
  headers: Record<string, string>
}

// ============================================
// 版本池
// ============================================

/** Chromium 大版本（覆盖 2024-Q3 ~ 2026-Q1，保持"近期但不过新"） */
const CHROME_MAJORS = [125, 126, 127, 128, 129, 130, 131, 132, 133]

// ============================================
// 平台池（权重模拟真实流量占比）
// ============================================

interface PlatformEntry {
  ua: string
  secPlatform: string
  weight: number
}

const PLATFORMS: PlatformEntry[] = [
  { ua: 'Windows NT 10.0; Win64; x64', secPlatform: '"Windows"', weight: 62 },
  { ua: 'Macintosh; Intel Mac OS X 10_15_7', secPlatform: '"macOS"', weight: 8 },
  { ua: 'Macintosh; Intel Mac OS X 13_6_9', secPlatform: '"macOS"', weight: 5 },
  { ua: 'Macintosh; Intel Mac OS X 14_4_1', secPlatform: '"macOS"', weight: 5 },
  { ua: 'Macintosh; Intel Mac OS X 14_7_2', secPlatform: '"macOS"', weight: 4 },
  { ua: 'Macintosh; Intel Mac OS X 15_1', secPlatform: '"macOS"', weight: 3 },
  { ua: 'Macintosh; Intel Mac OS X 15_2', secPlatform: '"macOS"', weight: 3 },
  { ua: 'X11; Linux x86_64', secPlatform: '"Linux"', weight: 10 },
]

// ============================================
// 浏览器类型
// ============================================

interface BrowserEntry {
  brandName: string
  isEdge: boolean
  weight: number
}

const BROWSERS: BrowserEntry[] = [
  { brandName: 'Google Chrome', isEdge: false, weight: 70 },
  { brandName: 'Microsoft Edge', isEdge: true, weight: 30 },
]

// ============================================
// Accept-Language 池（English 主语言 + 各种二级语言）
// ============================================

const ACCEPT_LANGUAGES = [
  'en-US,en;q=0.9',
  'en-US,en;q=0.9,es;q=0.8',
  'en-US,en;q=0.9,es;q=0.8,es-MX;q=0.7',
  'en-US,en;q=0.9,fr;q=0.8',
  'en-US,en;q=0.9,fr;q=0.8,fr-CA;q=0.7',
  'en-US,en;q=0.9,de;q=0.8',
  'en-US,en;q=0.9,pt;q=0.8',
  'en-US,en;q=0.9,pt-BR;q=0.8,pt;q=0.7',
  'en-US,en;q=0.9,it;q=0.8',
  'en-US,en;q=0.9,ja;q=0.8',
  'en-US,en;q=0.9,ko;q=0.8',
  'en-US,en;q=0.9,nl;q=0.8',
  'en-US,en;q=0.9,ru;q=0.8',
  'en-US,en;q=0.9,pl;q=0.8',
  'en-US,en;q=0.9,sv;q=0.8',
  'en-US,en;q=0.9,da;q=0.8',
  'en-US,en;q=0.9,fi;q=0.8',
  'en-US,en;q=0.9,nb;q=0.8',
  'en-US,en;q=0.9,tr;q=0.8',
  'en-US,en;q=0.9,vi;q=0.8',
  'en-US,en;q=0.9,ar;q=0.8',
  'en-GB,en;q=0.9',
  'en-GB,en-US;q=0.9,en;q=0.8',
  'en-AU,en;q=0.9,en-US;q=0.8',
  'en-CA,en;q=0.9,en-US;q=0.8',
  'en,en-US;q=0.9',
]

/** "Not_A Brand" 版本变体（Chrome 不同大版本间使用不同的值） */
const NOT_A_BRAND_VERSIONS = ['8', '24', '99']

// ============================================
// 工具函数
// ============================================

function randomInt(min: number, max: number): number {
  return Math.floor(Math.random() * (max - min + 1)) + min
}

function randomItem<T>(arr: readonly T[]): T {
  return arr[Math.floor(Math.random() * arr.length)]
}

/**
 * 按权重随机选择（轮盘赌）
 */
function weightedRandom<T extends { weight: number }>(items: readonly T[]): T {
  const total = items.reduce((sum, item) => sum + item.weight, 0)
  let r = Math.random() * total
  for (const item of items) {
    r -= item.weight
    if (r <= 0) return item
  }
  return items[items.length - 1]
}

// ============================================
// 核心生成函数
// ============================================

/**
 * 生成一个随机但内部一致的浏览器指纹。
 *
 * 每次调用返回不同的组合，同一次追踪会话中应复用同一个指纹实例，
 * 确保整条重定向链的请求头保持一致（真实浏览器行为）。
 *
 * 返回的 headers 不含 Referer / Cookie / Sec-Fetch-Site 等
 * 请求级动态头——这些由 tracker 的 buildBrowserHeaders 按每跳设置。
 */
export function generateFingerprint(): BrowserFingerprint {
  const browser = weightedRandom(BROWSERS)
  const platform = weightedRandom(PLATFORMS)
  const major = randomItem(CHROME_MAJORS)
  const notABrandV = randomItem(NOT_A_BRAND_VERSIONS)
  const acceptLang = randomItem(ACCEPT_LANGUAGES)

  // Chrome 构建号格式：major.0.XXXX.YY
  const chromeBuild = `${major}.0.${randomInt(6200, 6999)}.${randomInt(50, 200)}`

  let ua = `Mozilla/5.0 (${platform.ua}) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${chromeBuild} Safari/537.36`

  let secChUa: string
  if (browser.isEdge) {
    const edgeBuild = `${major}.0.${randomInt(2800, 2999)}.${randomInt(50, 150)}`
    ua += ` Edg/${edgeBuild}`
    secChUa = `"Microsoft Edge";v="${major}", "Chromium";v="${major}", "Not_A Brand";v="${notABrandV}"`
  } else {
    secChUa = `"Google Chrome";v="${major}", "Chromium";v="${major}", "Not_A Brand";v="${notABrandV}"`
  }

  const headers: Record<string, string> = {
    'Accept-Language': acceptLang,
    'Sec-Ch-Ua': secChUa,
    'Sec-Ch-Ua-Mobile': '?0',
    'Sec-Ch-Ua-Platform': platform.secPlatform,
  }

  return { userAgent: ua, headers }
}
