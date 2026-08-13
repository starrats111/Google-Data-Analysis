/**
 * 重定向追踪器
 * 
 * 负责追踪联盟链接的完整重定向链路
 * 支持 HTTP 重定向、Meta Refresh、JavaScript 跳转
 */

// 代理支持
import { HttpsProxyAgent } from 'https-proxy-agent'
import { SocksProxyAgent } from 'socks-proxy-agent'
import * as https from 'https'

// node-fetch v3 是纯 ESM，CJS 侧只能动态 import；这里缓存一次避免每跳都解析模块。
// 不用全局 fetch 的原因：原生 fetch 不支持 agent 选项，跟不了 SOCKS5 代理。
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type NodeFetch = (url: string, init?: any) => Promise<any>
let cachedFetch: NodeFetch | null = null
async function getFetch(): Promise<NodeFetch> {
  if (!cachedFetch) {
    const mod = await import('node-fetch')
    cachedFetch = (mod.default ?? mod) as unknown as NodeFetch
  }
  return cachedFetch
}

import type {
  AffiliateVerifyRequest,
  AffiliateVerifyResponse,
  RedirectType,
  ProxyRequestConfig,
} from './types'
import { extractRootDomain, normalizeDomain } from './domain-validator'
import { generateFingerprint } from './browser-fingerprint'

/**
 * 住宅代理常见自签/中间人证书，跟链只取跳转目标不取内容，放宽校验。
 * 移植自 kylink proxy-selector，内联以免把整个代理选择器一起搬过来。
 */
function createSocksAgent(proxyUrl: string, timeout: number): SocksProxyAgent {
  const agent = new SocksProxyAgent(proxyUrl, { timeout })
  const origConnect = agent.connect.bind(agent)
  agent.connect = ((req: never, opts: never) => {
    ;(opts as Record<string, unknown>).rejectUnauthorized = false
    return origConnect(req, opts)
  }) as typeof agent.connect
  return agent
}

// ============================================
// 追踪器接口定义
// ============================================

/**
 * 重定向追踪器接口
 */
export interface IRedirectTracker {
  /**
   * 追踪联盟链接的重定向链路
   * @param request 验证请求参数
   * @returns 验证响应结果
   */
  trace(request: AffiliateVerifyRequest): Promise<AffiliateVerifyResponse>
}

/**
 * 单次请求的追踪结果（内部使用）
 */
export interface TraceResult {
  /** 是否成功获取响应 */
  success: boolean
  
  /** 响应状态码 */
  statusCode?: number
  
  /** 响应头 */
  headers?: Record<string, string>
  
  /** 响应体（用于解析 meta/js 重定向） */
  body?: string
  
  /** 下一跳 URL（如果有重定向） */
  nextUrl?: string
  
  /** 重定向类型 */
  redirectType?: RedirectType
  
  /** 错误信息 */
  error?: string
}

/**
 * 追踪器配置选项
 */
export interface TrackerOptions {
  /** 代理配置（为空则不使用代理） */
  proxy?: ProxyRequestConfig
  
  /** 请求超时时间（毫秒） */
  timeout?: number
  
  /** 自定义 User-Agent */
  userAgent?: string
  
  /** 自定义请求头 */
  headers?: Record<string, string>
}

/**
 * HTML 重定向提取结果
 */
export interface HtmlRedirectResult {
  /** 提取到的跳转 URL */
  url: string
  
  /** 重定向类型：meta refresh 或 JavaScript 跳转 */
  type: 'meta' | 'js'
}

// ============================================
// JavaScript 跳转正则模式（可扩展）
// ============================================

/**
 * JavaScript 跳转模式定义
 */
interface JsRedirectPattern {
  /** 模式名称（用于调试） */
  name: string
  
  /** 正则表达式 */
  regex: RegExp
  
  /** URL 在匹配结果中的组索引（从 1 开始） */
  urlGroup: number
}

/**
 * JavaScript 跳转正则模式数组
 * 按优先级排序，先匹配的优先
 * 
 * 支持的跳转方式：
 * - window.location.href = "url"
 * - window.location = "url"
 * - location.href = "url"
 * - location = "url"
 * - location.replace("url")
 * - location.assign("url")
 * - document.location = "url"
 * - document.location.href = "url"
 * - self.location = "url"
 * - top.location = "url"
 * - parent.location = "url"
 * - setTimeout 包裹的跳转
 * - setInterval 包裹的跳转
 */
const JS_REDIRECT_PATTERNS: JsRedirectPattern[] = [
  // === location.replace / location.assign ===
  {
    name: 'location.replace',
    // 匹配: (window.|document.|self.|top.|parent.)?location.replace("url") 或 ('url')
    regex: /(?:window\.|document\.|self\.|top\.|parent\.)?location\.replace\s*\(\s*["'`]([^"'`]+)["'`]\s*\)/gi,
    urlGroup: 1,
  },
  {
    name: 'location.assign',
    // 匹配: (window.|document.|self.|top.|parent.)?location.assign("url")
    regex: /(?:window\.|document\.|self\.|top\.|parent\.)?location\.assign\s*\(\s*["'`]([^"'`]+)["'`]\s*\)/gi,
    urlGroup: 1,
  },
  
  // === window.location.href = "url" ===
  {
    name: 'window.location.href',
    // 匹配: window.location.href = "url"
    regex: /window\.location\.href\s*=\s*["'`]([^"'`]+)["'`]/gi,
    urlGroup: 1,
  },
  
  // === document.location.href = "url" ===
  {
    name: 'document.location.href',
    regex: /document\.location\.href\s*=\s*["'`]([^"'`]+)["'`]/gi,
    urlGroup: 1,
  },
  
  // === self.location.href / top.location.href / parent.location.href ===
  {
    name: 'self.location.href',
    regex: /self\.location\.href\s*=\s*["'`]([^"'`]+)["'`]/gi,
    urlGroup: 1,
  },
  {
    name: 'top.location.href',
    regex: /top\.location\.href\s*=\s*["'`]([^"'`]+)["'`]/gi,
    urlGroup: 1,
  },
  {
    name: 'parent.location.href',
    regex: /parent\.location\.href\s*=\s*["'`]([^"'`]+)["'`]/gi,
    urlGroup: 1,
  },
  {
    name: 'parent.location (assignment)',
    regex: /parent\.location\s*=\s*["'`]([^"'`]+)["'`]/gi,
    urlGroup: 1,
  },
  
  // === location.href = "url" (不带前缀) ===
  {
    name: 'location.href',
    regex: /(?<![.\w])location\.href\s*=\s*["'`]([^"'`]+)["'`]/gi,
    urlGroup: 1,
  },
  
  // === window.location = "url" ===
  {
    name: 'window.location',
    // 匹配 window.location = "url"，排除 window.location.xxx
    regex: /window\.location\s*=\s*["'`]([^"'`]+)["'`]/gi,
    urlGroup: 1,
  },
  
  // === document.location = "url" ===
  {
    name: 'document.location',
    regex: /document\.location\s*=\s*["'`]([^"'`]+)["'`]/gi,
    urlGroup: 1,
  },
  
  // === self.location / top.location / parent.location ===
  {
    name: 'self.location',
    regex: /self\.location\s*=\s*["'`]([^"'`]+)["'`]/gi,
    urlGroup: 1,
  },
  {
    name: 'top.location',
    regex: /top\.location\s*=\s*["'`]([^"'`]+)["'`]/gi,
    urlGroup: 1,
  },
  {
    name: 'parent.location',
    regex: /parent\.location\s*=\s*["'`]([^"'`]+)["'`]/gi,
    urlGroup: 1,
  },
  
  // === location = "url" (不带任何前缀) ===
  {
    name: 'location',
    // 使用负向后行断言，排除 xxx.location
    regex: /(?<![.\w])location\s*=\s*["'`]([^"'`]+)["'`]/gi,
    urlGroup: 1,
  },
  
  // === setTimeout 包裹 ===
  {
    name: 'setTimeout location.href',
    // 匹配: setTimeout(function() { location.href = "url" }, xxx)
    // 或: setTimeout(() => { location.href = "url" }, xxx)
    regex: /setTimeout\s*\([^)]*(?:window\.|document\.)?location(?:\.href)?\s*=\s*["'`]([^"'`]+)["'`]/gi,
    urlGroup: 1,
  },
  {
    name: 'setTimeout location.replace',
    regex: /setTimeout\s*\([^)]*(?:window\.|document\.)?location\.(?:replace|assign)\s*\(\s*["'`]([^"'`]+)["'`]/gi,
    urlGroup: 1,
  },
  
  // === setInterval 包裹（少见但存在） ===
  {
    name: 'setInterval location',
    regex: /setInterval\s*\([^)]*(?:window\.|document\.)?location(?:\.href)?\s*=\s*["'`]([^"'`]+)["'`]/gi,
    urlGroup: 1,
  },
  
  // === window.open 作为重定向（当前窗口） ===
  {
    name: 'window.open _self',
    // window.open("url", "_self") - 在当前窗口打开
    regex: /window\.open\s*\(\s*["'`]([^"'`]+)["'`]\s*,\s*["'`]_self["'`]/gi,
    urlGroup: 1,
  },
  
  // === 变量形式（常见混淆） ===
  {
    name: 'var redirect (named)',
    // 匹配: var redirectUrl = "url" 后面紧跟 location 赋值（变量名含 url/redirect/link/href）
    regex: /(?:var|let|const)\s+\w*(?:url|redirect|link|href)\w*\s*=\s*["'`]([^"'`]+)["'`]\s*;?\s*(?:window\.|document\.)?location/gi,
    urlGroup: 1,
  },
  {
    name: 'var redirect (any var + http url)',
    // 匹配: var/let/const 任意变量 = "http(s)://url"; 后跟 location 使用
    // 支持 collabglow 等联盟平台的变量间接重定向：var u = "https://..."; location.replace(u);
    regex: /(?:var|let|const)\s+\w+\s*=\s*["'`](https?:\/\/[^"'`]+)["'`]\s*;?\s*(?:window\.|document\.|self\.|top\.|parent\.)?location/gi,
    urlGroup: 1,
  },
  
  // === eval 包裹（安全考虑，但需要支持） ===
  {
    name: 'eval location',
    regex: /eval\s*\(\s*["'`][^"'`]*location(?:\.href)?\s*=\s*\\?["'`]([^"'`\\]+)/gi,
    urlGroup: 1,
  },
]

/**
 * Meta Refresh 正则模式
 * 支持多种格式：
 * - <meta http-equiv="refresh" content="0;url=xxx">
 * - <meta http-equiv="refresh" content="0; url=xxx">
 * - <meta http-equiv="refresh" content="5;URL='xxx'">
 * - <meta http-equiv='refresh' content='0;url=xxx'>
 */
const META_REFRESH_PATTERNS: RegExp[] = [
  // 标准格式：http-equiv="refresh" content="N;url=xxx"
  /<meta[^>]*http-equiv\s*=\s*["']?refresh["']?[^>]*content\s*=\s*["']?\d+\s*;\s*url\s*=\s*["']?([^"'\s>]+)["']?[^>]*>/gi,
  
  // content 在前：content="N;url=xxx" http-equiv="refresh"
  /<meta[^>]*content\s*=\s*["']?\d+\s*;\s*url\s*=\s*["']?([^"'\s>]+)["']?[^>]*http-equiv\s*=\s*["']?refresh["']?[^>]*>/gi,
  
  // 无 url= 前缀的简化格式（少见）：content="0; https://xxx"
  /<meta[^>]*http-equiv\s*=\s*["']?refresh["']?[^>]*content\s*=\s*["']?\d+\s*;\s*["']?(https?:\/\/[^"'\s>]+)["']?[^>]*>/gi,
]

// ============================================
// HTML 重定向提取函数
// ============================================

/**
 * 从 HTML 内容中提取重定向 URL
 * 支持 Meta Refresh 和 JavaScript 跳转
 * 
 * @param html HTML 内容
 * @param baseUrl 基准 URL，用于解析相对路径
 * @returns 提取结果，包含 url 和 type；无重定向则返回 null
 * 
 * @example
 * // Meta Refresh
 * extractHtmlRedirectUrl('<meta http-equiv="refresh" content="0;url=/landing">', 'https://example.com')
 * // { url: 'https://example.com/landing', type: 'meta' }
 * 
 * // JavaScript 跳转
 * extractHtmlRedirectUrl('<script>window.location.href = "/page";</script>', 'https://example.com')
 * // { url: 'https://example.com/page', type: 'js' }
 */
export function extractHtmlRedirectUrl(html: string, baseUrl: string): HtmlRedirectResult | null {
  if (!html || typeof html !== 'string') {
    return null
  }

  // 先尝试解析 Meta Refresh（优先级更高，更可靠）
  const metaResult = extractMetaRefreshUrl(html, baseUrl)
  if (metaResult) {
    return metaResult
  }

  // 再尝试解析 JavaScript 跳转
  const jsResult = extractJsRedirectUrl(html, baseUrl)
  if (jsResult) {
    return jsResult
  }

  return null
}

/**
 * 从 HTML 中提取 Meta Refresh URL
 */
function extractMetaRefreshUrl(html: string, baseUrl: string): HtmlRedirectResult | null {
  for (const pattern of META_REFRESH_PATTERNS) {
    // 重置正则状态
    pattern.lastIndex = 0
    
    const match = pattern.exec(html)
    if (match && match[1]) {
      const resolvedUrl = resolveAndValidateUrl(match[1], baseUrl)
      if (resolvedUrl) {
        return { url: resolvedUrl, type: 'meta' }
      }
    }
  }
  return null
}

/**
 * 从 HTML 中提取 JavaScript 跳转 URL
 */
function extractJsRedirectUrl(html: string, baseUrl: string): HtmlRedirectResult | null {
  // 遍历所有模式
  for (const pattern of JS_REDIRECT_PATTERNS) {
    // 重置正则状态
    pattern.regex.lastIndex = 0
    
    const match = pattern.regex.exec(html)
    if (match && match[pattern.urlGroup]) {
      const rawUrl = match[pattern.urlGroup]
      const resolvedUrl = resolveAndValidateUrl(rawUrl, baseUrl)
      if (resolvedUrl) {
        return { url: resolvedUrl, type: 'js' }
      }
    }
  }
  return null
}

/**
 * 还原从 HTML/JS/JSON 中提取的 URL 里的转义序列。
 *
 * 联盟页常把跳转地址写在内联 JS 或 JSON 字符串里，含 `\uXXXX`、`\xXX`、`\/`
 * 等转义；正则只能拿到原始字符串，若不还原就会请求到被污染的地址。
 * 典型故障：Adjust 深链 token 里出现字面量 `\u0026`(应为 `&`)、`\u003C`(应为 `<`)，
 * 导致目标服务器无法识别 token 而返回 404。
 *
 * @param raw 提取到的原始 URL 字符串
 * @returns 还原转义后的字符串
 */
function decodeExtractedUrlEscapes(raw: string): string {
  let s = raw
  // \/ → /
  s = s.replace(/\\\//g, '/')
  // \uXXXX → 对应字符
  s = s.replace(/\\u([0-9a-fA-F]{4})/g, (_m, hex) => {
    try { return String.fromCharCode(parseInt(hex, 16)) } catch { return _m }
  })
  // \xXX → 对应字符
  s = s.replace(/\\x([0-9a-fA-F]{2})/g, (_m, hex) => {
    try { return String.fromCharCode(parseInt(hex, 16)) } catch { return _m }
  })
  // HTML 属性里常见的 &amp; → &
  s = s.replace(/&amp;/gi, '&')
  return s
}

/**
 * 解析并验证 URL
 * - 支持相对路径
 * - 支持缺协议 URL（//example.com）
 * - 过滤非 http(s) 协议
 * - 过滤与 baseUrl 相同的 URL（避免死循环）
 * 
 * @param rawUrl 原始 URL（可能是相对路径）
 * @param baseUrl 基准 URL
 * @returns 有效的绝对 URL，或 null
 */
function resolveAndValidateUrl(rawUrl: string, baseUrl: string): string | null {
  if (!rawUrl || typeof rawUrl !== 'string') {
    return null
  }

  // 去除首尾空格和可能的引号
  let url = rawUrl.trim().replace(/^["'`]|["'`]$/g, '')

  // 还原从内联 JS/JSON/HTML 提取出的转义序列（\uXXXX、\xXX、\/、&amp;）。
  // 联盟页常把跳转地址写在 JS 字符串里，正则只能拿到原始字符串，
  // 不还原会请求到被污染的地址（如 Adjust token 含字面量 \u0026/\u003C → 404）。
  url = decodeExtractedUrlEscapes(url)

  // 过滤非 http(s) 协议
  const lowerUrl = url.toLowerCase()
  if (
    lowerUrl.startsWith('javascript:') ||
    lowerUrl.startsWith('mailto:') ||
    lowerUrl.startsWith('tel:') ||
    lowerUrl.startsWith('data:') ||
    lowerUrl.startsWith('blob:') ||
    lowerUrl.startsWith('about:') ||
    lowerUrl.startsWith('file:') ||
    lowerUrl.startsWith('vbscript:') ||
    lowerUrl.startsWith('#') // 锚点
  ) {
    return null
  }

  // 解析 URL
  let resolvedUrl: string
  try {
    // 处理协议相对 URL（//example.com/path）
    if (url.startsWith('//')) {
      const baseProtocol = new URL(baseUrl).protocol
      url = baseProtocol + url
    }

    // 修正联盟平台常见畸形：hostname 后 & 应为 ?
    if (url.startsWith('http://') || url.startsWith('https://')) {
      url = fixMalformedQueryInHostname(url)
    }

    // 使用 URL 构造函数解析（自动处理相对路径）
    const urlObj = new URL(url, baseUrl)
    
    // 验证协议必须是 http 或 https
    if (urlObj.protocol !== 'http:' && urlObj.protocol !== 'https:') {
      return null
    }

    resolvedUrl = urlObj.href
  } catch {
    // URL 解析失败
    return null
  }

  // 检查是否与 baseUrl 相同（避免死循环）
  if (isSameUrl(resolvedUrl, baseUrl)) {
    return null
  }

  return resolvedUrl
}

/**
 * 判断两个 URL 是否相同（忽略末尾斜杠和片段标识符）
 */
function isSameUrl(url1: string, url2: string): boolean {
  try {
    const u1 = new URL(url1)
    const u2 = new URL(url2)

    // 移除片段标识符
    u1.hash = ''
    u2.hash = ''

    // 标准化路径（移除末尾斜杠）
    const path1 = u1.pathname.replace(/\/+$/, '') || '/'
    const path2 = u2.pathname.replace(/\/+$/, '') || '/'

    return (
      u1.protocol === u2.protocol &&
      u1.hostname.toLowerCase() === u2.hostname.toLowerCase() &&
      u1.port === u2.port &&
      path1 === path2 &&
      u1.search === u2.search
    )
  } catch {
    return url1 === url2
  }
}

// ============================================
// singleRequest 函数类型定义
// ============================================

/**
 * 代理配置（用于 singleRequest）
 */
export interface SingleRequestProxy {
  /** 代理 URL（如 http://proxy.example.com:8080 或 socks5://proxy.example.com:1080） */
  url: string
  
  /** 代理认证用户名 */
  username?: string
  
  /** 代理认证密码 */
  password?: string
  
  /** 代理协议类型（默认根据端口自动判断，或明确指定） */
  protocol?: 'http' | 'https' | 'socks5'
}

/**
 * singleRequest 配置选项
 */
export interface SingleRequestOptions {
  /** 代理配置 */
  proxy?: SingleRequestProxy
  
  /** 请求超时时间（毫秒，默认 10000） */
  timeout?: number
  
  /** 自定义 User-Agent */
  userAgent?: string
  
  /** Referer 头 */
  referer?: string
  
  /** 额外的请求头 */
  headers?: Record<string, string>

  /** 要随请求发送的 Cookie 字符串（如 "key1=val1; key2=val2"） */
  cookies?: string

  /** 是否输出代理类型日志（默认 true，trackRedirects 后续跳传 false 避免重复） */
  logProxy?: boolean

  /** 只要响应头，拿到就掐断连接、不读响应体（已知这是最后一跳时用，见 MAX_BODY_BYTES 注释） */
  skipBody?: boolean

  /** 响应体最多读多少字节，超出即掐断（默认 MAX_BODY_BYTES） */
  maxBodyBytes?: number
}

/**
 * 响应体最多读多少字节。
 *
 * 跟跳只从响应体里拿两样东西：meta refresh / JS 跳转目标，以及出错时的页面标题用于诊断。
 * 前者按 HTML 规范必须在 `<head>` 里，后者也在开头——都落在头几 KB。而广告主落地页动辄
 * 几百 KB，整页读完纯属白烧住宅代理流量（基准实测第一步中位数 46KB，绝大部分是这个）。
 * 64KB 是解压后的量，按 gzip 常见 4 倍压缩比算，实际过代理的不到 16KB。
 */
const MAX_BODY_BYTES = 64 * 1024

/** 出错页只用来提标题做诊断，16KB 绰绰有余（Cloudflare 挑战页整页能到 100KB+）。 */
const MAX_ERROR_BODY_BYTES = 16 * 1024

/**
 * 读响应体，读满 maxBytes 就掐断连接。
 *
 * 注意读到的是解压后的字节数：node-fetch 会自动 gunzip，destroy 解压流会向下游传导到 socket，
 * 所以掐断是真的省了代理流量，不是只省了内存。
 */
async function readBodyCapped(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  response: any,
  maxBytes: number,
): Promise<string> {
  const body = response?.body
  if (!body) return ''
  const chunks: Buffer[] = []
  let total = 0
  try {
    for await (const chunk of body) {
      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
      chunks.push(buf)
      total += buf.length
      if (total >= maxBytes) break
    }
  } catch {
    /* 流中途断了：用已经读到的部分，跟跳照常继续 */
  } finally {
    discardBody(response)
  }
  return Buffer.concat(chunks).toString('utf8')
}

/**
 * 丢弃响应体并立刻释放连接。
 *
 * 只读响应头就 return 而不动 body，在 node-fetch + keep-alive agent 下数据还会继续往下收、
 * socket 也没法复用——等于流量照烧。所有「不需要响应体」的分支都必须显式调这个。
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function discardBody(response: any): void {
  try {
    response?.body?.destroy?.()
  } catch {
    /* 已经关了就算了 */
  }
}

/**
 * singleRequest 返回结果
 */
export interface SingleRequestResult {
  /** HTTP 状态码 */
  statusCode: number
  
  /** 重定向目标 URL（3xx 或 meta/js 跳转时） */
  redirectUrl: string | null
  
  /** 最终请求的 URL */
  finalUrl: string
  
  /** 重定向类型 */
  redirectType?: 'http' | 'meta' | 'js'
  
  /** Content-Type 响应头 */
  contentType?: string
  
  /** 响应体片段（错误时或 HTML 时） */
  bodySnippet?: string
  
  /** 错误信息 */
  error?: string

  /** 响应中的 Set-Cookie 头（用于跨跳 Cookie 传递） */
  setCookies?: string[]
}

// ============================================
// 默认浏览器请求头
// ============================================

/**
 * 默认 User-Agent（模拟 Chrome 浏览器）
 */
const DEFAULT_USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'

/**
 * 构建模拟浏览器的请求头
 */
function buildBrowserHeaders(options: SingleRequestOptions): Record<string, string> {
  const headers: Record<string, string> = {
    'User-Agent': options.userAgent || DEFAULT_USER_AGENT,
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8,application/signed-exchange;v=b3;q=0.7',
    'Accept-Language': 'en-US,en;q=0.9',
    'Accept-Encoding': 'gzip, deflate, br',
    'Cache-Control': 'no-cache',
    'Pragma': 'no-cache',
    // Sec-Fetch-* 系列头（现代浏览器特征）
    'Sec-Fetch-Dest': 'document',
    'Sec-Fetch-Mode': 'navigate',
    'Sec-Fetch-Site': 'none',
    'Sec-Fetch-User': '?1',
    'Sec-Ch-Ua': '"Google Chrome";v="131", "Chromium";v="131", "Not_A Brand";v="24"',
    'Sec-Ch-Ua-Mobile': '?0',
    'Sec-Ch-Ua-Platform': '"Windows"',
    'Upgrade-Insecure-Requests': '1',
  }

  // 添加 Referer
  if (options.referer) {
    headers['Referer'] = options.referer
    // 如果有 referer，调整 Sec-Fetch-Site
    try {
      new URL(options.referer) // validate referer URL format
      // 简化判断：有 referer 就设为 cross-site
      headers['Sec-Fetch-Site'] = 'cross-site'
      // 可选：更精细的判断
      // if (refererUrl.hostname === new URL(targetUrl).hostname) {
      //   headers['Sec-Fetch-Site'] = 'same-origin'
      // }
    } catch {
      // referer 无效，忽略
    }
  }

  // 添加 Cookie
  if (options.cookies) {
    headers['Cookie'] = options.cookies
  }

  // 合并自定义请求头
  if (options.headers) {
    Object.assign(headers, options.headers)
  }

  return headers
}

// ============================================
// singleRequest 核心函数
// ============================================

/**
 * 执行单次 HTTP 请求
 * 
 * - 使用 manual redirect 模式
 * - 支持代理（通过 https-proxy-agent）
 * - 模拟浏览器请求头
 * - 处理证书问题（rejectUnauthorized=false）
 * - 解析 HTTP 重定向、Meta Refresh、JavaScript 跳转
 * 
 * @param url 请求 URL
 * @param options 配置选项
 * @returns 请求结果
 * 
 * @example
 * const result = await singleRequest('https://affiliate.example.com/link', {
 *   proxy: { url: 'http://proxy.example.com:8080' },
 *   referer: 'https://t.co',
 *   timeout: 10000,
 * })
 */
export async function singleRequest(url: string, options: SingleRequestOptions = {}): Promise<SingleRequestResult> {
  const timeout = options.timeout ?? 10000

  try {
    // 构建请求头
    const headers = buildBrowserHeaders(options)

    // 构建 fetch agent（处理代理和证书）
    let agent: https.Agent | HttpsProxyAgent<string> | SocksProxyAgent

    if (options.proxy) {
      // 使用代理
      let proxyUrl = options.proxy.url

      // 如果有认证信息，添加到 URL
      if (options.proxy.username && options.proxy.password) {
        const proxyUrlObj = new URL(proxyUrl)
        proxyUrlObj.username = options.proxy.username
        proxyUrlObj.password = options.proxy.password
        proxyUrl = proxyUrlObj.href
      }

      // 判断代理协议类型
      const isSocks5 = options.proxy.protocol === 'socks5' || 
                       proxyUrl.startsWith('socks5://') || 
                       proxyUrl.startsWith('socks://') ||
                       options.proxy.url.includes(':1080') || // 常见 SOCKS 端口
                       options.proxy.url.includes(':2333') || // ipidea 端口
                       options.proxy.url.includes(':4950')    // abcproxy 端口

      if (isSocks5) {
        // SOCKS5 代理
        // 确保 URL 使用 socks5:// 协议
        if (!proxyUrl.startsWith('socks')) {
          proxyUrl = proxyUrl.replace(/^https?:\/\//, 'socks5://')
        }
        agent = createSocksAgent(proxyUrl, timeout)
        if (options.logProxy !== false) {
          console.log(`[tracker] Using SOCKS5 proxy: ${options.proxy.url}`)
        }
      } else {
        // HTTP/HTTPS 代理
        agent = new HttpsProxyAgent(proxyUrl, {
          rejectUnauthorized: false,
        })
        if (options.logProxy !== false) {
          console.log(`[tracker] Using HTTP proxy: ${options.proxy.url}`)
        }
      }
    } else {
      // 无代理，使用普通 Agent（同样禁用证书验证）
      agent = new https.Agent({
        rejectUnauthorized: false,
      })
    }

    // 执行请求
    const controller = new AbortController()
    const timeoutId = setTimeout(() => controller.abort(), timeout)

    const fetchFn = await getFetch()
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let response: any
    try {
      response = await fetchFn(url, {
        method: 'GET',
        headers,
        redirect: 'manual', // 手动处理重定向
        agent,
        signal: controller.signal,
      })
    } finally {
      clearTimeout(timeoutId)
    }

    const statusCode = response.status
    const contentType = response.headers.get('content-type') || undefined

    // 提取 Set-Cookie 头（用于跨跳 Cookie 传递）
    let setCookies: string[] | undefined
    try {
      // node-fetch 的 headers.raw() 返回原始多值头
      const rawHeaders = (response.headers as { raw?: () => Record<string, string[]> }).raw?.()
      if (rawHeaders && rawHeaders['set-cookie']) {
        setCookies = rawHeaders['set-cookie']
      }
    } catch {
      // 提取失败不影响主流程
    }

    // ============================================
    // 处理 HTTP 重定向 (3xx)
    // ============================================
    if (isRedirectStatusCode(statusCode)) {
      const locationHeader = response.headers.get('location')
      
      if (!locationHeader) {
        discardBody(response)
        return {
          statusCode,
          redirectUrl: null,
          finalUrl: url,
          redirectType: 'http',
          contentType,
          setCookies,
          error: 'MISSING_LOCATION_HEADER',
        }
      }

      // 解析 Location 为绝对 URL
      const redirectUrl = resolveToAbsoluteHttpUrl(locationHeader, url)
      
      if (!redirectUrl) {
        discardBody(response)
        return {
          statusCode,
          redirectUrl: null,
          finalUrl: url,
          redirectType: 'http',
          contentType,
          setCookies,
          error: 'INVALID_REDIRECT_URL',
        }
      }

      // 3xx 只需要 Location 头，响应体（哪怕只是一句 "Redirecting..."）一律不收
      discardBody(response)
      return {
        statusCode,
        redirectUrl,
        finalUrl: url,
        redirectType: 'http',
        contentType,
        setCookies,
      }
    }

    // 已知这是最后一跳（目标域名在发请求前就匹配上了）：请求本身是为了完成点击注册，
    // 落地页 URL 早已在手，整页 HTML 一个字节都不用收。这是省流量最大的一刀。
    if (options.skipBody) {
      discardBody(response)
      return {
        statusCode,
        redirectUrl: null,
        finalUrl: url,
        contentType,
        setCookies,
        error: statusCode >= 400 ? `HTTP_ERROR_${statusCode}` : undefined,
      }
    }

    // ============================================
    // 处理错误响应 (4xx/5xx)
    // ============================================
    if (statusCode >= 400) {
      // 出错页只用来提标题做诊断，读够 16KB 就掐断
      let bodySnippet: string | undefined
      try {
        bodySnippet = (await readBodyCapped(response, MAX_ERROR_BODY_BYTES)).slice(0, 2000)
      } catch {
        bodySnippet = undefined
      }

      return {
        statusCode,
        redirectUrl: null,
        finalUrl: url,
        contentType,
        bodySnippet,
        setCookies,
        error: `HTTP_ERROR_${statusCode}`,
      }
    }

    // ============================================
    // 处理正常响应 (2xx)
    // ============================================
    
    // 检查是否为 HTML 内容
    const isHtml = contentType?.toLowerCase().includes('text/html')
    
    if (!isHtml) {
      // 非 HTML（图片/JSON/PDF 等）：解析不出 meta/js 跳转，收下来也没用，直接掐断
      discardBody(response)
      return {
        statusCode,
        redirectUrl: null,
        finalUrl: url,
        contentType,
        setCookies,
      }
    }

    // 读取 HTML 内容（封顶，不整页收）
    let htmlBody: string
    try {
      htmlBody = await readBodyCapped(response, options.maxBodyBytes ?? MAX_BODY_BYTES)
    } catch (err) {
      return {
        statusCode,
        redirectUrl: null,
        finalUrl: url,
        contentType,
        setCookies,
        error: `READ_BODY_ERROR: ${err instanceof Error ? err.message : String(err)}`,
      }
    }

    // 解析 Meta Refresh 或 JavaScript 跳转
    const htmlRedirect = extractHtmlRedirectUrl(htmlBody, url)
    
    if (htmlRedirect) {
      return {
        statusCode,
        redirectUrl: htmlRedirect.url,
        finalUrl: url,
        redirectType: htmlRedirect.type,
        contentType,
        bodySnippet: htmlBody.slice(0, 2000),
        setCookies,
      }
    }

    // 无重定向
    return {
      statusCode,
      redirectUrl: null,
      finalUrl: url,
      contentType,
      bodySnippet: htmlBody.slice(0, 2000),
      setCookies,
    }

  } catch (err) {
    // 处理各种错误，返回友好的错误信息
    const error = err instanceof Error ? err : new Error(String(err))
    
    let errorCode = 'REQUEST_FAILED'
    let friendlyMessage = error.message
    
    if (error.name === 'AbortError') {
      errorCode = 'TIMEOUT'
      friendlyMessage = '请求超时，代理或目标服务器响应过慢'
    } else if (error.message.includes('ECONNREFUSED')) {
      errorCode = 'CONNECTION_REFUSED'
      friendlyMessage = '连接被拒绝，代理服务器可能不可用'
    } else if (error.message.includes('ENOTFOUND')) {
      errorCode = 'DNS_ERROR'
      friendlyMessage = 'DNS 解析失败，域名可能无效'
    } else if (error.message.includes('CERT') || error.message.includes('SSL')) {
      errorCode = 'SSL_ERROR'
      friendlyMessage = 'SSL 证书验证失败'
    } else if (error.message.includes('socket hang up')) {
      errorCode = 'CONNECTION_RESET'
      friendlyMessage = '连接被重置，服务器可能中断了连接'
    } else if (error.message.includes('ETIMEDOUT')) {
      errorCode = 'TIMEOUT'
      friendlyMessage = '连接超时，网络可能不稳定'
    } else if (error.message.includes('ECONNRESET')) {
      errorCode = 'CONNECTION_RESET'
      friendlyMessage = '连接被重置'
    }

    // 广告追踪/联盟平台增强诊断
    if (isAdTrackerUrl(url)) {
      friendlyMessage += `（广告追踪服务 ${extractDomain(url)} 可能有地域限制，请确认代理 IP 在目标国家）`
    } else if (hasEmbeddedTargetUrl(url)) {
      friendlyMessage += `（联盟平台 ${extractDomain(url)} 可能封禁数据中心 IP，将尝试从 URL 提取目标地址继续）`
    }

    return {
      statusCode: 0,
      redirectUrl: null,
      finalUrl: url,
      error: `${errorCode}: ${friendlyMessage}`,
    }
  }
}

/**
 * 修正联盟平台常见的畸形 URL：hostname 后直接拼 &param= 而非 ?param=。
 *
 * 原因：某些联盟追踪器（如 efi.afftrk1.com）在构造重定向时，
 * 对没有 query string 的目标 URL 错误地用 & 拼接参数：
 *   https://www.samsung.com&referer=https://...   ← 畸形
 *   https://www.samsung.com?referer=https://...   ← 正确
 *
 * Node.js URL parser 不会拒绝这类 URL，但会将 &... 当作 hostname 的一部分，
 * 导致 DNS 解析失败（hostname 含非法字符 &）。
 *
 * 修正策略：解析后检测 hostname 是否含 &，若含则从原始字符串中将
 * 首个紧跟 hostname 的 & 替换为 ?。
 */
function fixMalformedQueryInHostname(rawUrl: string): string {
  try {
    const parsed = new URL(rawUrl)
    if (!parsed.hostname.includes('&')) return rawUrl

    // hostname 含 &：从原始字符串找到 scheme://hostname 之后的首个 & 替换为 ?
    // 匹配模式：https://some.host.com&param=... → https://some.host.com?param=...
    const schemeEnd = rawUrl.indexOf('://') + 3
    if (schemeEnd < 3) return rawUrl

    const afterScheme = rawUrl.substring(schemeEnd)
    const ampIdx = afterScheme.indexOf('&')
    if (ampIdx === -1) return rawUrl

    // 确保 & 之前没有 /、?、# （说明 & 确实在 hostname 区域）
    const before = afterScheme.substring(0, ampIdx)
    if (/[/?#]/.test(before)) return rawUrl

    const fixed = rawUrl.substring(0, schemeEnd + ampIdx) + '?' + rawUrl.substring(schemeEnd + ampIdx + 1)
    // 验证修正后的 URL 有效
    const check = new URL(fixed)
    if (check.hostname.includes('&')) return rawUrl // 仍然畸形则放弃
    console.log(`[tracker] Fixed malformed URL: hostname '&' → '?': ${fixed.substring(0, 120)}`)
    return fixed
  } catch {
    return rawUrl
  }
}

/**
 * D-234：算出跳转链中间跳该发什么 Referer，口径 = 浏览器默认的 `strict-origin-when-cross-origin`。
 *
 * 原实现（移植自 kylink）第 2 跳起直接把**上一跳完整 URL** 当 Referer 发出去，两个后果：
 *   1. 合规事故——Tradedoubler 收到后会把它回显成 `referer=` 参数一路带到落地页，
 *      落地页 query 又被当作追踪后缀入库，等于把我方联盟中转链接（含 track token）
 *      印在广告到达网址上交给广告主（D-234 报案，已投 1985 次）。
 *   2. 反爬指纹破绽——真实浏览器跨源跳转只发 origin，绝不发完整 path，
 *      发完整 path 本身就是「这不是浏览器」的特征。
 *
 * 现按浏览器真实行为：同源发完整 URL、跨源只发 origin、https→http 降级不发。
 */
export function computeHopReferer(previousUrl: string | null, targetUrl: string): string | undefined {
  if (!previousUrl) return undefined
  let prev: URL
  let next: URL
  try {
    prev = new URL(previousUrl)
    next = new URL(targetUrl)
  } catch {
    return undefined
  }
  // 安全降级（https → http）：浏览器完全不发 Referer
  if (prev.protocol === 'https:' && next.protocol !== 'https:') return undefined
  // 同源：发完整 URL（含 path/query），与浏览器一致
  if (prev.origin === next.origin) return previousUrl
  // 跨源：只发 origin，不泄露 path 与 token
  return `${prev.origin}/`
}

/**
 * 将 Location 头解析为绝对 http(s) URL
 * 
 * @param location Location 头的值
 * @param baseUrl 基准 URL
 * @returns 绝对 URL，如果无效则返回 null
 */
function resolveToAbsoluteHttpUrl(location: string, baseUrl: string): string | null {
  if (!location || typeof location !== 'string') {
    return null
  }

  try {
    // 处理协议相对 URL
    let url = location.trim()
    if (url.startsWith('//')) {
      const baseProtocol = new URL(baseUrl).protocol
      url = baseProtocol + url
    }

    // 修正联盟平台常见畸形：hostname 后 & 应为 ?
    url = fixMalformedQueryInHostname(url)

    // 解析为绝对 URL
    const urlObj = new URL(url, baseUrl)

    // 验证协议
    if (urlObj.protocol !== 'http:' && urlObj.protocol !== 'https:') {
      return null
    }

    return urlObj.href
  } catch {
    return null
  }
}

// ============================================
// 追踪器类
// ============================================

/**
 * 重定向追踪器类
 * 
 * TODO: 实现具体的追踪逻辑
 */
export class RedirectTracker implements IRedirectTracker {
  private options: TrackerOptions

  constructor(options: TrackerOptions = {}) {
    this.options = options
  }

  /**
   * 追踪联盟链接的重定向链路
   */
  async trace(request: AffiliateVerifyRequest): Promise<AffiliateVerifyResponse> {
    void request
    // TODO: 实现追踪逻辑
    throw new Error('Not implemented')
  }

  /**
   * 执行单次请求并解析响应
   * 使用 singleRequest 函数
   */
  private async executeRequest(url: string, referrer?: string): Promise<TraceResult> {
    const result = await singleRequest(url, {
      proxy: this.options.proxy ? {
        url: `${this.options.proxy.protocol}://${this.options.proxy.proxyIp}:${this.options.proxy.port}`,
        username: this.options.proxy.username,
        password: this.options.proxy.password,
      } : undefined,
      referer: referrer,
      timeout: this.options.timeout,
      userAgent: this.options.userAgent,
      headers: this.options.headers,
    })

    return {
      success: !result.error,
      statusCode: result.statusCode,
      nextUrl: result.redirectUrl ?? undefined,
      redirectType: result.redirectType,
      body: result.bodySnippet,
      error: result.error,
    }
  }

  /**
   * 从响应头解析 HTTP 重定向
   */
  private parseHttpRedirect(statusCode: number, headers: Record<string, string>): string | null {
    if (!isRedirectStatusCode(statusCode)) {
      return null
    }
    const location = headers['location'] || headers['Location']
    return location || null
  }

  /**
   * 从响应体解析重定向（Meta Refresh 或 JavaScript）
   * 使用 extractHtmlRedirectUrl 函数
   */
  private parseHtmlRedirect(body: string, baseUrl: string): HtmlRedirectResult | null {
    return extractHtmlRedirectUrl(body, baseUrl)
  }
}

// ============================================
// 工具函数
// ============================================

/**
 * 从 URL 中提取域名
 */
export function extractDomain(url: string): string {
  try {
    const urlObj = new URL(url)
    return urlObj.hostname
  } catch {
    return ''
  }
}

/**
 * 判断是否为 HTTP 重定向状态码
 */
export function isRedirectStatusCode(statusCode: number): boolean {
  return [301, 302, 303, 307, 308].includes(statusCode)
}

/**
 * 解析相对 URL 为绝对 URL
 */
export function resolveUrl(baseUrl: string, relativeUrl: string): string {
  try {
    return new URL(relativeUrl, baseUrl).href
  } catch {
    return relativeUrl
  }
}

// ============================================
// 测试用例
// ============================================

/**
 * 运行 extractHtmlRedirectUrl 测试用例
 */
export function runHtmlRedirectTests(): void {
  console.log('=== extractHtmlRedirectUrl 测试用例 ===\n')

  const baseUrl = 'https://example.com/page'

  const testCases = [
    // Meta Refresh 测试
    {
      name: '用例1: Meta Refresh 标准格式',
      html: '<html><head><meta http-equiv="refresh" content="0;url=https://target.com/landing"></head></html>',
      expected: { url: 'https://target.com/landing', type: 'meta' },
    },
    {
      name: '用例2: Meta Refresh 相对路径',
      html: '<meta http-equiv="refresh" content="5; url=/new-page">',
      expected: { url: 'https://example.com/new-page', type: 'meta' },
    },
    {
      name: '用例3: Meta Refresh 带引号',
      html: '<meta http-equiv="refresh" content="0;url=\'https://target.com\'">',
      expected: { url: 'https://target.com/', type: 'meta' },
    },
    
    // JavaScript 跳转测试
    {
      name: '用例4: window.location.href',
      html: '<script>window.location.href = "https://target.com/js-redirect";</script>',
      expected: { url: 'https://target.com/js-redirect', type: 'js' },
    },
    {
      name: '用例5: location.href 相对路径',
      html: '<script>location.href = "/relative/path";</script>',
      expected: { url: 'https://example.com/relative/path', type: 'js' },
    },
    {
      name: '用例6: location.replace',
      html: '<script>location.replace("https://target.com/replaced");</script>',
      expected: { url: 'https://target.com/replaced', type: 'js' },
    },
    {
      name: '用例7: location.assign',
      html: '<script>window.location.assign("/assigned");</script>',
      expected: { url: 'https://example.com/assigned', type: 'js' },
    },
    {
      name: '用例8: document.location',
      html: '<script>document.location = "https://target.com/doc";</script>',
      expected: { url: 'https://target.com/doc', type: 'js' },
    },
    {
      name: '用例9: self.location',
      html: '<script>self.location.href = "https://target.com/self";</script>',
      expected: { url: 'https://target.com/self', type: 'js' },
    },
    {
      name: '用例10: top.location',
      html: '<script>top.location = "https://target.com/top";</script>',
      expected: { url: 'https://target.com/top', type: 'js' },
    },
    {
      name: '用例11: setTimeout 包裹',
      html: '<script>setTimeout(function(){ location.href = "https://target.com/timeout"; }, 1000);</script>',
      expected: { url: 'https://target.com/timeout', type: 'js' },
    },
    {
      name: '用例12: 协议相对 URL (//)',
      html: '<script>location.href = "//target.com/protocol-relative";</script>',
      expected: { url: 'https://target.com/protocol-relative', type: 'js' },
    },
    
    // 过滤测试
    {
      name: '用例13: 过滤 javascript:',
      html: '<script>location.href = "javascript:void(0)";</script>',
      expected: null,
    },
    {
      name: '用例14: 过滤 mailto:',
      html: '<meta http-equiv="refresh" content="0;url=mailto:test@example.com">',
      expected: null,
    },
    {
      name: '用例15: 过滤相同 URL（防止死循环）',
      html: '<script>location.href = "https://example.com/page";</script>',
      expected: null,
    },
    
    // 无重定向
    {
      name: '用例16: 无重定向的普通 HTML',
      html: '<html><head><title>Hello</title></head><body>Normal page</body></html>',
      expected: null,
    },
    
    // 单引号和反引号
    {
      name: '用例17: 单引号',
      html: "<script>location.href = 'https://target.com/single-quote';</script>",
      expected: { url: 'https://target.com/single-quote', type: 'js' },
    },
    {
      name: '用例18: 模板字符串（反引号）',
      html: '<script>location.href = `https://target.com/template`;</script>',
      expected: { url: 'https://target.com/template', type: 'js' },
    },
  ]

  let passed = 0
  let failed = 0

  for (const tc of testCases) {
    const result = extractHtmlRedirectUrl(tc.html, baseUrl)
    
    const isPass = tc.expected === null
      ? result === null
      : result !== null && result.url === tc.expected.url && result.type === tc.expected.type

    if (isPass) {
      console.log(`✅ ${tc.name}`)
      passed++
    } else {
      console.log(`❌ ${tc.name}`)
      console.log(`   期望: ${JSON.stringify(tc.expected)}`)
      console.log(`   实际: ${JSON.stringify(result)}`)
      failed++
    }
  }

  console.log(`\n=== 测试结果: ${passed} 通过, ${failed} 失败 ===`)
}

// ============================================
// 广告追踪服务 URL 提取（地域限制兜底）
// ============================================

/**
 * 已知的广告追踪/点击服务器域名。
 * 这些服务常作为联盟链路的中间跳转，可能有地域限制。
 */
const AD_TRACKER_DOMAINS = new Set([
  'ad.doubleclick.net',
  'www.googleadservices.com',
  'clickserve.dartsearch.net',
  'ad.atdmt.com',
  'click.google.com',
  'servedby.flashtalking.com',
])

/**
 * 已知的联盟平台域名，其 URL 中嵌入了目标站地址（如 `new=` 参数）。
 * 当通过代理访问失败（平台封禁数据中心 IP）时，可从 URL 提取目标地址继续追踪。
 */
const AFFILIATE_PLATFORM_DOMAINS = new Set([
  'www.linkhaitao.com',
  'linkhaitao.com',
  'webep1.com',
  'www.webep1.com',
  'action.metaffiliation.com',
])

/**
 * 检查 URL 是否属于已知的广告追踪/点击服务器
 */
function isAdTrackerUrl(url: string): boolean {
  try {
    const hostname = new URL(url).hostname.toLowerCase()
    return AD_TRACKER_DOMAINS.has(hostname)
  } catch {
    return false
  }
}

/**
 * 检查 URL 是否属于已知的联盟平台或广告追踪服务，且 URL 中可能嵌入了目标地址。
 */
function hasEmbeddedTargetUrl(url: string): boolean {
  try {
    const hostname = new URL(url).hostname.toLowerCase()
    return AD_TRACKER_DOMAINS.has(hostname) || AFFILIATE_PLATFORM_DOMAINS.has(hostname)
  } catch {
    return false
  }
}

/**
 * 已知的「移动 App 深度链接 / 归因」服务域名。
 *
 * 这类链接是给真人在手机上点击的：会唤起 App 或跳到对应网页兜底地址。
 * kylink 验证器是服务器端、桌面 UA、数据中心代理访问，深链在这种上下文下
 * 通常返回 404 或落到与目标站无关的地址 → 误判「域名不匹配 / 失败」。
 * 因此对这类域名不直接请求，而是从其参数里提取网页兜底目标继续追踪。
 */
const APP_DEEPLINK_DOMAINS = new Set([
  'adj.st',      // Adjust
  'app.link',    // Branch
  'bnc.lt',      // Branch 短链
  'onelink.me',  // AppsFlyer
  'go.link',     // AppsFlyer
  'page.link',   // Firebase Dynamic Links
  'smart.link',  // SmartLink
])

/**
 * 检查 URL 是否属于 App 深度链接 / 归因服务域名（含子域名，如 bxfd.adj.st）。
 */
function isAppDeeplinkUrl(url: string): boolean {
  try {
    const hostname = new URL(url).hostname.toLowerCase()
    for (const domain of APP_DEEPLINK_DOMAINS) {
      if (hostname === domain || hostname.endsWith('.' + domain)) {
        return true
      }
    }
    return false
  } catch {
    return false
  }
}

/**
 * 从 App 深链（Adjust / Branch / AppsFlyer / Firebase 等）中提取网页兜底目标 URL。
 *
 * 策略：
 * 1. 优先匹配各平台常见的「网页兜底 / 落地」参数（url、fallback、$desktop_url、af_web_dp 等）。
 * 2. 兜底：扫描所有参数值，取第一个非深链域名的 http(s) URL。
 *
 * @returns 提取到的网页目标 URL，或 null
 */
function extractDeeplinkFallbackUrl(url: string): string | null {
  let urlObj: URL
  try {
    urlObj = new URL(url)
  } catch {
    return null
  }

  const fallbackKeys = [
    // 通用
    'url', 'fallback', 'fallback_url', 'redirect', 'redirect_url',
    'deep_link', 'deeplink', 'link', 'dest', 'target', 'u',
    // AppsFlyer
    'af_web_dp', 'af_r', 'af_dp',
    // Branch
    '$fallback_url', '$desktop_url', '$web_only_url', '$ios_url', '$android_url',
  ]

  const normalizeCandidate = (value: string | null): string | null => {
    if (!value) return null
    let candidate = value.trim()
    // 可能是 URL 编码后的地址
    if (!/^https?:\/\//i.test(candidate)) {
      try {
        candidate = decodeURIComponent(candidate)
      } catch {
        // 解码失败保持原样
      }
    }
    if (!/^https?:\/\//i.test(candidate)) return null
    try {
      new URL(candidate)
      // 兜底目标不能仍然是深链域名，否则可能死循环
      if (isAppDeeplinkUrl(candidate)) return null
      return candidate
    } catch {
      return null
    }
  }

  // 1. 优先匹配已知兜底参数
  for (const key of fallbackKeys) {
    const got = normalizeCandidate(urlObj.searchParams.get(key))
    if (got) return got
  }

  // 2. 兜底：扫描所有参数值
  for (const [, value] of urlObj.searchParams) {
    const got = normalizeCandidate(value)
    if (got) return got
  }

  return null
}

/**
 * 从广告追踪服务 URL 中提取嵌入的目标 URL。
 *
 * DoubleClick DDM 格式:
 *   https://ad.doubleclick.net/ddm/clk/...?https://www.example.com/path?param=value
 * 目标 URL 嵌在 `?` 后面。
 *
 * 也处理常见的 `url=` / `dest=` / `redirect=` / `landing=` 参数格式。
 *
 * @returns 提取到的目标 URL，或 null
 */
function extractEmbeddedUrlFromAdTracker(adUrl: string): string | null {
  try {
    const urlObj = new URL(adUrl)
    const hostname = urlObj.hostname.toLowerCase()

    // DoubleClick DDM: 查询字符串本身就是目标 URL
    if (hostname === 'ad.doubleclick.net' && urlObj.pathname.startsWith('/ddm/')) {
      const rawSearch = urlObj.search
      if (rawSearch && rawSearch.length > 1) {
        const embedded = rawSearch.substring(1) // 去掉开头的 ?
        // 检查是否以 http:// 或 https:// 开头
        if (embedded.startsWith('http://') || embedded.startsWith('https://')) {
          try {
            new URL(embedded) // 校验格式
            return embedded
          } catch {
            // 可能需要 URL 解码
            try {
              const decoded = decodeURIComponent(embedded)
              new URL(decoded)
              return decoded
            } catch {
              // 格式无效
            }
          }
        }
      }
    }

    // 通用参数提取：url= / dest= / redirect= / landing= / goto= / new=（linkhaitao）
    const urlParams = ['url', 'dest', 'redirect', 'landing', 'goto', 'target', 'redir', 'new']
    for (const param of urlParams) {
      const value = urlObj.searchParams.get(param)
      if (value && (value.startsWith('http://') || value.startsWith('https://'))) {
        try {
          new URL(value)
          return value
        } catch {
          // 无效 URL
        }
      }
    }

    // Base64/Base64URL 编码的目标地址（常见于 webep1.com 等联盟追踪器的 r= 参数）
    const base64Params = ['r', 'redirect_url', 'dest_url']
    for (const param of base64Params) {
      const value = urlObj.searchParams.get(param)
      if (!value || value.length < 10) continue
      const decoded = tryDecodeBase64Url(value)
      if (decoded) return decoded
    }
  } catch {
    // URL 解析失败
  }
  return null
}

/**
 * 尝试将 Base64 或 Base64URL 编码的字符串解码为有效的 http(s) URL。
 * 联盟追踪器（如 webep1.com）常将目标地址 Base64 编码后放在 r= 参数中。
 *
 * @returns 解码后的有效 URL，或 null
 */
function tryDecodeBase64Url(encoded: string): string | null {
  try {
    // Base64URL → 标准 Base64（替换 - → +、_ → /）
    const standardBase64 = encoded.replace(/-/g, '+').replace(/_/g, '/')
    const decoded = Buffer.from(standardBase64, 'base64').toString('utf-8')
    if (decoded.startsWith('http://') || decoded.startsWith('https://')) {
      new URL(decoded)
      return decoded
    }
  } catch { /* 非有效 Base64 或 URL */ }
  return null
}

// ============================================
// trackRedirects 类型定义
// ============================================

/**
 * 可重试的网络层错误
 * 这些错误通常是瞬态的，重试可能成功
 */
const RETRYABLE_NETWORK_ERRORS = [
  'AbortError',
  'ECONNRESET',
  'ECONNREFUSED',
  'ETIMEDOUT',
  'EAI_AGAIN',         // 临时 DNS 失败
  'TIMEOUT',
  'CONNECTION_RESET',
  'CONNECTION_REFUSED',
  'SSL_ERROR',
  'socket hang up',
]

/**
 * 可重试的 HTTP 状态错误（服务端临时故障）
 */
const RETRYABLE_HTTP_ERRORS = [
  'HTTP_ERROR_429',    // Too Many Requests（限流）
  'HTTP_ERROR_502',    // Bad Gateway
  'HTTP_ERROR_503',    // Service Unavailable
  'HTTP_ERROR_504',    // Gateway Timeout
]

/**
 * 确定性不可重试的追踪错误（Fatal）
 * 重试不会改变结果，应立即停止以节省时间和资源
 */
const FATAL_TRACKING_ERRORS = [
  'HTTP_ERROR_404',    // 页面不存在
  'HTTP_ERROR_403',    // 访问被拒绝（目标站反爬/IP 封禁）
  'HTTP_ERROR_410',    // 页面已永久删除
  'HTTP_ERROR_451',    // 因法律原因不可用
  'DNS_ERROR',         // 域名不存在，代理无法解析
  'INVALID_REDIRECT_URL',    // 重定向 URL 结构无效
  'MISSING_LOCATION_HEADER', // 3xx 响应缺少 Location 头
]

/**
 * 判断错误是否可重试
 */
function isRetryableError(error: string): boolean {
  return RETRYABLE_NETWORK_ERRORS.some(e => error.includes(e)) ||
         RETRYABLE_HTTP_ERRORS.some(e => error.includes(e))
}

/**
 * 判断是否为确定性不可重试错误
 * 用于立即停止无意义的重试
 */
function isFatalTrackingError(error: string): boolean {
  return FATAL_TRACKING_ERRORS.some(prefix => error.startsWith(prefix))
}

/**
 * 代理供应商拦截页面特征
 * 当 HTTP 4xx/5xx 的响应体匹配这些特征时，说明 403 来自代理而非目标站
 */
const PROXY_BLOCK_PAGE_SIGNATURES = [
  'proxy-block',
  'proxy_error',
  'proxy error',
  'tunnel connection failed',
  'ERR_TUNNEL_CONNECTION_FAILED',
]

/**
 * 将 HTTP 错误响应体摘要为人类可读的诊断信息。
 * - 检测广告追踪服务地域限制 → 输出地域限制诊断
 * - 检测代理供应商拦截页面 → 输出明确诊断
 * - 检测联盟平台反爬页面 → 输出针对性建议
 * - 其他 HTML → 提取 <title> 文本
 * - 纯文本 → 截断到 120 字符
 */
function summarizeHttpErrorBody(statusCode: number, bodySnippet: string, url: string): string {
  // 广告追踪服务/联盟平台诊断（优先级最高）
  if (isAdTrackerUrl(url)) {
    const domain = extractDomain(url) ?? url
    return `广告追踪服务 ${domain} 可能有地域限制（HTTP ${statusCode}），请确认代理出口 IP 在目标国家`
  }
  if (hasEmbeddedTargetUrl(url) && !isAdTrackerUrl(url)) {
    const domain = extractDomain(url) ?? url
    return `联盟平台 ${domain} 可能封禁数据中心 IP（HTTP ${statusCode}），已尝试从 URL 参数提取目标地址`
  }

  if (!bodySnippet) return url

  const isHtml = bodySnippet.includes('<!DOCTYPE') || bodySnippet.includes('<html')

  if (isHtml) {
    const lower = bodySnippet.toLowerCase()

    const isProxyBlock = PROXY_BLOCK_PAGE_SIGNATURES.some(sig => lower.includes(sig.toLowerCase()))
    if (isProxyBlock) {
      return '代理服务拦截请求（可能账户过期/余额不足/区域权限不够），请检查代理供应商后台'
    }

    const domain = extractDomain(url) ?? url
    const titleMatch = bodySnippet.match(/<title[^>]*>([^<]+)<\/title>/i)
    const pageTitle = titleMatch?.[1]?.trim()

    if (statusCode === 403) {
      return `联盟平台反爬拦截（${domain}${pageTitle ? `，页面标题: ${pageTitle}` : ''}），建议稍后重试或更换代理`
    }

    if (pageTitle) {
      return `${pageTitle}（${domain}）`
    }

    return `目标站返回 HTML 错误页（${domain}）`
  }

  return bodySnippet.slice(0, 120)
}

/**
 * trackRedirects 配置选项
 */
export interface TrackRedirectsOptions {
  /** 起始 URL（必填） */
  url: string
  
  /** 代理配置 */
  proxy?: SingleRequestProxy
  
  /** 目标域名（用于早停判断） */
  targetDomain?: string
  
  /** 第一跳的 Referer（默认 https://t.co） */
  initialReferer?: string
  
  /** 最大重定向次数（默认 10） */
  maxRedirects?: number
  
  /** 单次请求超时时间（毫秒，默认 10000） */
  requestTimeout?: number
  
  /** 总超时时间（毫秒，默认 60000） */
  totalTimeout?: number
  
  /** 网络错误重试次数（默认 2） */
  retryCount?: number
  
  /** 自定义 User-Agent */
  userAgent?: string
  
  /** 额外的请求头 */
  headers?: Record<string, string>
}

/**
 * 重定向步骤详细信息
 */
export interface RedirectStepInfo {
  /** 步骤序号（从 1 开始） */
  step: number
  
  /** 当前 URL */
  url: string
  
  /** 域名 */
  domain: string
  
  /** HTTP 状态码 */
  statusCode: number
  
  /** 重定向类型 */
  redirectType?: 'http' | 'meta' | 'js'
  
  /** 下一跳 URL（如果有） */
  nextUrl?: string
  
  /** 该步骤耗时（毫秒） */
  duration?: number
  
  /** 错误信息（如果有） */
  error?: string
}

/**
 * 域名验证结果
 */
export interface DomainValidation {
  /** 是否匹配目标域名 */
  isValid: boolean
  
  /** 目标根域名 */
  targetDomain: string
  
  /** 实际根域名 */
  actualDomain: string
}

/**
 * trackRedirects 返回结果
 */
export interface TrackRedirectsResult {
  /** 是否成功（无错误且状态码 < 400） */
  success: boolean
  
  /** 最终落地页 URL */
  finalUrl: string
  
  /** 最终状态码 */
  finalStatusCode: number
  
  /** 重定向次数 */
  redirectCount: number
  
  /** 重定向链（URL 数组） */
  redirectChain: string[]
  
  /** 重定向步骤详情 */
  redirectSteps: RedirectStepInfo[]
  
  /** 总耗时（毫秒） */
  duration: number
  
  /** 域名验证结果（当传入 targetDomain 时） */
  domainValidation?: DomainValidation
  
  /** 错误信息 */
  errorMessage?: string
  
  /** 是否因早停而结束 */
  earlyStop?: boolean
}

// ============================================
// trackRedirects 核心函数
// ============================================

/**
 * 追踪完整重定向链路
 * 
 * 功能：
 * - 支持 HTTP 重定向、Meta Refresh、JavaScript 跳转
 * - 支持代理
 * - 支持网络错误重试
 * - 支持目标域名早停
 * - 支持超时控制（单次 + 总超时）
 * 
 * @param options 配置选项
 * @returns 追踪结果
 * 
 * @example
 * const result = await trackRedirects({
 *   url: 'https://affiliate.example.com/link',
 *   targetDomain: 'amazon.com',
 *   initialReferer: 'https://t.co',
 *   proxy: { url: 'http://proxy.example.com:8080' },
 * })
 */
export async function trackRedirects(options: TrackRedirectsOptions): Promise<TrackRedirectsResult> {
  const startTime = Date.now()
  
  // 默认值
  const maxRedirects = options.maxRedirects ?? 10
  const requestTimeout = options.requestTimeout ?? 10000
  const totalTimeout = options.totalTimeout ?? 60000
  const retryCount = options.retryCount ?? 2
  const initialReferer = options.initialReferer ?? 'https://t.co'

  // 为本次追踪会话生成随机浏览器指纹（同一重定向链内所有请求复用）
  const fingerprint = generateFingerprint()
  const sessionUserAgent = options.userAgent || fingerprint.userAgent
  const sessionHeaders = { ...fingerprint.headers, ...options.headers }
  console.log(`[tracker] Session fingerprint: ${sessionUserAgent.substring(0, 80)}...`)
  
  // 状态变量
  const redirectChain: string[] = []
  const redirectSteps: RedirectStepInfo[] = []
  let currentUrl = options.url
  let previousUrl: string | null = null
  let finalStatusCode = 0
  let errorMessage: string | undefined
  let earlyStop = false

  // Cookie Jar：跨跳维护 cookie（domain → { name → "name=value" }）
  const cookieJar: Map<string, Map<string, string>> = new Map()

  /**
   * 从 Set-Cookie 头中提取 cookie 并存入 jar
   * @param setCookies Set-Cookie 头数组
   * @param url 当前请求 URL（用于确定默认 domain）
   */
  function collectCookies(setCookies: string[] | undefined, url: string): void {
    if (!setCookies || setCookies.length === 0) return
    let defaultDomain: string
    try {
      defaultDomain = new URL(url).hostname
    } catch {
      return
    }
    for (const raw of setCookies) {
      // 取 "name=value" 部分（分号前的首段）
      const pair = raw.split(';')[0]?.trim()
      if (!pair || !pair.includes('=')) continue
      const cookieName = pair.split('=')[0].trim()
      // 尝试提取 Domain 属性
      let domain = defaultDomain
      const domainMatch = raw.match(/;\s*[Dd]omain\s*=\s*([^;]+)/)
      if (domainMatch) {
        domain = domainMatch[1].trim().replace(/^\./, '') // 去掉前导点
      }
      if (!cookieJar.has(domain)) {
        cookieJar.set(domain, new Map())
      }
      cookieJar.get(domain)!.set(cookieName, pair)
    }
  }

  /**
   * 根据目标 URL 的域名构建 Cookie 请求头
   * @param url 目标请求 URL
   * @returns cookie 字符串或 undefined
   */
  function buildCookieHeader(url: string): string | undefined {
    let hostname: string
    try {
      hostname = new URL(url).hostname
    } catch {
      return undefined
    }
    const matched: string[] = []
    for (const [domain, cookies] of cookieJar) {
      // 简单匹配：hostname 等于 domain 或以 .domain 结尾
      if (hostname === domain || hostname.endsWith('.' + domain)) {
        for (const pair of cookies.values()) {
          matched.push(pair)
        }
      }
    }
    return matched.length > 0 ? matched.join('; ') : undefined
  }
  
  // 将起始 URL 加入链路
  redirectChain.push(currentUrl)
  
  // 循环追踪重定向
  for (let i = 0; i < maxRedirects; i++) {
    // 检查总超时
    if (Date.now() - startTime > totalTimeout) {
      errorMessage = `TOTAL_TIMEOUT: 总耗时超过 ${totalTimeout}ms`
      break
    }
    
    const stepStartTime = Date.now()
    const stepNumber = i + 1
    
    // 确定本次请求的 Referer
    // 第 1 跳：使用 initialReferer（调用方给的真实来路，模拟从文章/站点点进来）
    // 第 2 跳开始：D-234 按浏览器 strict-origin-when-cross-origin 口径算，不再发完整上一跳 URL
    const referer = stepNumber === 1 ? initialReferer : computeHopReferer(previousUrl, currentUrl)

    // 早停检查：如果目标域名存在，检查当前 URL 是否已匹配
    // ⚠️ 关键改动：匹配后仍然先访问该 URL（完成点击注册），然后再停止
    let targetDomainMatched = false
    if (options.targetDomain && stepNumber > 1) {
      const currentRootDomain = extractRootDomain(currentUrl)
      const targetRootDomain = extractRootDomain(options.targetDomain) ?? normalizeDomain(options.targetDomain)
      
      if (currentRootDomain && targetRootDomain) {
        const normalizedCurrent = normalizeDomain(currentRootDomain)
        const normalizedTarget = normalizeDomain(targetRootDomain)
        
        if (normalizedCurrent === normalizedTarget) {
          // 域名匹配，标记为早停但先完成本次请求
          targetDomainMatched = true
        }
      }
    }
    
    // App 深链（Adjust/Branch/AppsFlyer 等）：服务器端直接请求深链通常返回 404，
    // 改为从深链参数中提取网页兜底目标，继续追踪到真实落地站再校验域名。
    if (isAppDeeplinkUrl(currentUrl)) {
      const fallbackUrl = extractDeeplinkFallbackUrl(currentUrl)
      if (fallbackUrl && !isSameUrl(fallbackUrl, currentUrl)) {
        console.log(`[tracker] App deeplink ${extractDomain(currentUrl)} detected, extracted web fallback: ${fallbackUrl.substring(0, 100)}`)
        redirectSteps.push({
          step: stepNumber,
          url: currentUrl,
          domain: extractDomain(currentUrl),
          statusCode: 0,
          nextUrl: fallbackUrl,
          duration: Date.now() - stepStartTime,
          error: 'APP_DEEPLINK（已从深链参数提取网页兜底目标继续追踪）',
        })
        previousUrl = currentUrl
        currentUrl = fallbackUrl
        redirectChain.push(currentUrl)
        continue
      }
    }

    // 构建本次请求的 Cookie 头
    const cookieHeader = buildCookieHeader(currentUrl)

    // 执行请求（带重试）
    let result: SingleRequestResult | null = null
    let lastError: string | undefined
    
    for (let retry = 0; retry <= retryCount; retry++) {
      try {
        result = await singleRequest(currentUrl, {
          proxy: options.proxy,
          timeout: requestTimeout,
          referer,
          userAgent: sessionUserAgent,
          headers: sessionHeaders,
          cookies: cookieHeader,
          logProxy: stepNumber === 1,
          // 目标域名在发请求前就匹配上了 → 这一跳必定是最后一跳（下面 targetDomainMatched 分支
          // 无论 2xx/4xx 都 break）。请求照发以完成点击注册，但落地页正文不收。
          skipBody: targetDomainMatched,
        })

        // 无错误：正常跳出
        if (!result.error) {
          break
        }

        lastError = result.error

        // 确定性错误（如 404、403、DNS 不存在）：立即停止，重试不会改变结果
        if (isFatalTrackingError(result.error)) {
          console.log(`[tracker] Fatal error at step ${stepNumber}, no retry: ${result.error.substring(0, 80)}`)
          break
        }

        // 非可重试错误：停止重试
        if (!isRetryableError(result.error)) {
          break
        }

        // 可重试错误（网络超时、503 等）：等待后重试
        if (retry < retryCount) {
          console.log(`[tracker] Retryable error at step ${stepNumber} (attempt ${retry + 1}/${retryCount + 1}): ${result.error.substring(0, 60)}`)
          await sleep(100 * (retry + 1))
        }
      } catch (err) {
        lastError = err instanceof Error ? err.message : String(err)

        // 确定性错误或不可重试错误：立即停止
        if (isFatalTrackingError(lastError) || !isRetryableError(lastError)) {
          break
        }

        // 可重试错误：等待后重试
        if (retry < retryCount) {
          await sleep(100 * (retry + 1))
        } else {
          break
        }
      }
    }
    
    const stepDuration = Date.now() - stepStartTime
    
    // 如果请求完全失败
    if (!result) {
      redirectSteps.push({
        step: stepNumber,
        url: currentUrl,
        domain: extractDomain(currentUrl),
        statusCode: 0,
        duration: stepDuration,
        error: lastError ?? 'REQUEST_FAILED',
      })

      // ⚠️ 关键：如果目标域名已匹配，即使访问失败也视为成功早停
      if (targetDomainMatched) {
        console.log(`[tracker] Target domain matched but request failed (${lastError?.substring(0, 60)}), treating as successful early stop`)
        earlyStop = true
        break
      }

      // 广告追踪/联盟平台兜底：从失败的 URL 中提取嵌入的目标 URL，继续追踪
      if (hasEmbeddedTargetUrl(currentUrl)) {
        const embeddedUrl = extractEmbeddedUrlFromAdTracker(currentUrl)
        if (embeddedUrl) {
          console.log(`[tracker] ${extractDomain(currentUrl)} failed, extracted embedded target URL: ${embeddedUrl.substring(0, 100)}`)
          redirectSteps[redirectSteps.length - 1].error = `${lastError} (已从 URL 参数提取目标地址继续追踪)`
          previousUrl = currentUrl
          currentUrl = embeddedUrl
          redirectChain.push(currentUrl)
          continue
        }
      }

      errorMessage = lastError ?? 'REQUEST_FAILED'
      break
    }

    // 收集本次响应的 Cookie
    collectCookies(result.setCookies, currentUrl)
    
    finalStatusCode = result.statusCode
    
    // 记录步骤信息
    const stepInfo: RedirectStepInfo = {
      step: stepNumber,
      url: currentUrl,
      domain: extractDomain(currentUrl),
      statusCode: result.statusCode,
      redirectType: result.redirectType,
      nextUrl: result.redirectUrl ?? undefined,
      duration: stepDuration,
      error: result.error,
    }
    redirectSteps.push(stepInfo)

    // 处理错误响应 (4xx/5xx)
    if (result.statusCode >= 400) {
      // ⚠️ 关键：目标域名已匹配时，4xx/5xx 也视为成功早停
      if (targetDomainMatched) {
        console.log(`[tracker] Target domain matched but got HTTP ${result.statusCode}, treating as successful early stop`)
        earlyStop = true
        break
      }

      // 广告追踪/联盟平台兜底：从失败的 URL 中提取嵌入的目标 URL，继续追踪
      if (hasEmbeddedTargetUrl(currentUrl)) {
        const embeddedUrl = extractEmbeddedUrlFromAdTracker(currentUrl)
        if (embeddedUrl) {
          console.log(`[tracker] ${extractDomain(currentUrl)} returned HTTP ${result.statusCode}, extracted embedded target URL: ${embeddedUrl.substring(0, 100)}`)
          redirectSteps[redirectSteps.length - 1].error = `HTTP ${result.statusCode}（地域限制/反爬），已从 URL 参数提取目标地址继续追踪`
          previousUrl = currentUrl
          currentUrl = embeddedUrl
          redirectChain.push(currentUrl)
          continue
        }
      }

      const snippet = result.bodySnippet?.slice(0, 500) ?? ''
      const readableSnippet = summarizeHttpErrorBody(result.statusCode, snippet, currentUrl)
      errorMessage = `HTTP_ERROR_${result.statusCode}: ${readableSnippet}`
      break
    }

    // 如果目标域名已匹配且响应正常，本次请求已完成（点击已注册），现在停止
    if (targetDomainMatched) {
      earlyStop = true
      break
    }
    
    // 如果有请求级错误但状态码正常，记录错误但继续
    if (result.error && result.statusCode === 0) {
      // 同样检查目标域名匹配
      if (targetDomainMatched) {
        console.log(`[tracker] Target domain matched but got error (${result.error?.substring(0, 60)}), treating as successful early stop`)
        earlyStop = true
        break
      }
      errorMessage = result.error
      break
    }
    
    // 检查是否有重定向
    if (!result.redirectUrl) {
      // 无重定向，追踪结束
      break
    }
    
    // 更新状态，准备下一跳
    previousUrl = currentUrl
    currentUrl = result.redirectUrl
    redirectChain.push(currentUrl)
  }
  
  // 计算总耗时
  const duration = Date.now() - startTime
  
  // 构建域名验证结果
  let domainValidation: DomainValidation | undefined
  if (options.targetDomain) {
    const actualRootDomain = extractRootDomain(currentUrl)
    const targetRootDomain = extractRootDomain(options.targetDomain) ?? normalizeDomain(options.targetDomain)
    
    const actualDomain = actualRootDomain ? normalizeDomain(actualRootDomain) : ''
    const targetDomain = targetRootDomain ? normalizeDomain(targetRootDomain) : ''
    
    domainValidation = {
      isValid: actualDomain !== '' && targetDomain !== '' && actualDomain === targetDomain,
      targetDomain,
      actualDomain,
    }
  }
  
  // 判断是否成功
  // 早停也算成功：目标域名已匹配，追踪参数已在 URL 中（即使目标站返回 4xx 或 CONNECTION_RESET）
  const success = earlyStop || (!errorMessage && finalStatusCode > 0 && finalStatusCode < 400)
  
  return {
    success,
    finalUrl: currentUrl,
    finalStatusCode,
    redirectCount: redirectChain.length - 1, // 不包括起始 URL
    redirectChain,
    redirectSteps,
    duration,
    domainValidation,
    errorMessage,
    earlyStop,
  }
}

/**
 * 延迟函数
 */
function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}
