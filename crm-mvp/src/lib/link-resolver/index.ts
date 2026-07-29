/**
 * D-193 取链接第一步：kylink 跟跳引擎接入 CRM。
 *
 * 这里只做「协议转换」——把移植自 kylink 的 `trackRedirects` 包装成 CRM `fetchChain`
 * 同形状的返回值，让 `affiliate-link-resolver` 里那套 CRM 独有判定（App 深链解包、
 * 上级联盟黑名单、D-182 落地洗参、跳板域名识别、tracker_forbidden）全部原样复用。
 *
 * 为什么值得换：kylink 的跟跳比 CRM 原生 `fetchChain` 多了 Cookie Jar 跨跳、内联 JS
 * 变量跳转、base64/嵌入 URL 解包、畸形 hostname 修复和目标域早停。基准集实测（2026-07-29，
 * 47 条真实链接）在「在投失败」组把直出从 7 条提到 12 条，流量还略低。
 */
import { trackRedirects } from './tracker'
import { generateFingerprint } from './browser-fingerprint'
import type { SingleRequestProxy } from './tracker'

/** 与 affiliate-link-resolver 的内部 ChainResult 同形状 */
export interface ChainLikeResult {
  finalUrl: string
  chain: string[]
  status: number
  error?: string
}

/** 把 `socks5://user:pass@host:port` 之类的代理 URL 拆成 tracker 要的结构。 */
export function parseProxyUrl(proxyUrl: string | null): SingleRequestProxy | undefined {
  if (!proxyUrl) return undefined
  try {
    const u = new URL(proxyUrl)
    const scheme = u.protocol.replace(':', '').toLowerCase()
    const protocol = scheme === 'socks' || scheme === 'socks5' ? 'socks5' : scheme === 'https' ? 'https' : 'http'
    return {
      url: `${protocol}://${u.hostname}:${u.port}`,
      username: u.username ? decodeURIComponent(u.username) : undefined,
      password: u.password ? decodeURIComponent(u.password) : undefined,
      protocol,
    }
  } catch {
    return undefined
  }
}

/**
 * 用 kylink 引擎跟完整条跳转链。
 *
 * 与 `fetchChain` 的签名刻意保持一致，调用点可以直接替换。`targetDomain` 是新增的可选项：
 * 传了就启用目标域早停——第一次命中商家根域名就停手，不再跟商家自己的规范化跳转，
 * 否则联盟追踪参数会被广告主前端洗掉（实测 PinkBlush 即此）。
 */
export async function fetchChainViaKy(
  startUrl: string,
  proxyUrl: string | null,
  maxRedirects = 15,
  perHopTimeoutMs = 18000,
  fp: { userAgent?: string | null; referer?: string | null } = {},
  retryCount = 2,
  targetDomain?: string | null,
): Promise<ChainLikeResult> {
  // 指纹要配套：kylink 的生成器只产桌面 Chrome（Sec-Ch-Ua-Mobile: ?0），而 CRM 跟链一律用
  // 移动端 UA（移动版落地页更轻、省代理流量）。混用会让 UA 和 client hints 自相矛盾。
  // 所以调用方给了 UA 就只补 Accept-Language，不带 Sec-Ch-Ua*；没给才整套用 kylink 的。
  const fingerprint = generateFingerprint()
  const useKyFingerprint = !fp.userAgent
  const r = await trackRedirects({
    url: startUrl,
    proxy: parseProxyUrl(proxyUrl),
    targetDomain: targetDomain || undefined,
    initialReferer: fp.referer || undefined,
    userAgent: fp.userAgent || fingerprint.userAgent,
    headers: useKyFingerprint
      ? fingerprint.headers
      : { 'Accept-Language': fingerprint.headers['Accept-Language'] },
    maxRedirects,
    requestTimeout: perHopTimeoutMs,
    // 总超时给到单跳的 3.5 倍，够跑完一条长链又不至于把补货 cron 拖死
    totalTimeout: Math.max(perHopTimeoutMs * 3.5, 45000),
    retryCount,
  })

  // 状态码优先取最后一跳实际值；异常路径（连接层就挂了）从错误串里回捞，
  // 让上层 tracker_forbidden 判定（4xx + 仍停在跳板域名）拿得到依据。
  let status = r.finalStatusCode || 0
  if (!status && r.errorMessage) {
    const m = r.errorMessage.match(/HTTP_ERROR_(\d{3})/)
    if (m) status = parseInt(m[1], 10)
  }

  return {
    finalUrl: r.finalUrl || '',
    chain: r.redirectChain?.length ? r.redirectChain : (r.finalUrl ? [r.finalUrl] : []),
    status,
    error: r.errorMessage,
  }
}
