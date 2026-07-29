/**
 * 验证联盟链接 - 接口契约定义
 * 
 * API 路径: POST /api/affiliate-configs/verify
 * 用途: 验证联盟链接的重定向链路，追踪跳转过程，用于前端 Timeline 展示
 */

// ============================================
// 请求类型定义
// ============================================

/**
 * 验证联盟链接 - 请求体
 */
export interface AffiliateVerifyRequest {
  /** 联盟链接 URL（必填） */
  affiliateLink: string
  
  /** 国家代码，如 US, JP, DE（必填，用于选择对应地区代理） */
  countryCode: string
  
  /** 目标域名，用于验证最终落地页是否匹配（可选） */
  targetDomain?: string
  
  /** 来源页面，模拟 Referer 头（默认 https://t.co） */
  referrer?: string
  
  /** 关联的广告系列 ID（可选，用于记录验证历史） */
  campaignId?: string
  
  /** 最大重定向次数（默认 10，防止无限循环） */
  maxRedirects?: number
}

// ============================================
// 响应类型定义
// ============================================

/**
 * 重定向类型
 * - http: HTTP 状态码重定向（301/302/303/307/308）
 * - meta: HTML meta refresh 重定向
 * - js: JavaScript 跳转（window.location 等）
 */
export type RedirectType = 'http' | 'meta' | 'js'

/**
 * 重定向链路中的单步记录
 * 用于前端 Timeline 组件展示每一跳的详情
 */
export interface RedirectStep {
  /** 步骤序号，从 1 开始 */
  step: number
  
  /** 当前步骤的完整 URL */
  url: string
  
  /** 当前步骤的域名（从 URL 解析） */
  domain: string
  
  /** HTTP 状态码（仅 http 类型重定向有值） */
  statusCode?: number
  
  /** 重定向类型 */
  redirectType?: RedirectType
}

/**
 * 尝试过的代理记录
 */
export interface TriedProxy {
  /** 代理供应商名称 */
  providerName: string
  
  /** 代理 IP/主机 */
  host: string
  
  /** 优先级 */
  priority: number
  
  /** 是否成功 */
  success: boolean
  
  /** 失败原因（当 success=false 时） */
  failReason?: string
}

/**
 * 验证联盟链接 - 响应体
 */
export interface AffiliateVerifyResponse {
  /** 请求是否成功执行（不代表链接有效） */
  success: boolean
  
  /** 重定向链路数组，按顺序记录每一跳 */
  redirectChain: RedirectStep[]
  
  /** 最终落地页 URL */
  finalUrl?: string
  
  /** 最终落地页域名 */
  finalDomain?: string
  
  /** 最终域名是否匹配目标域名（当传入 targetDomain 时计算） */
  matched: boolean
  
  /** 总重定向次数 */
  totalRedirects: number
  
  /** 验证耗时（毫秒） */
  duration?: number
  
  /** 错误信息（当 success=false 时返回） */
  error?: string
  
  /** 使用的代理出口 IP（用于调试） */
  proxyIp?: string
  
  /** 尝试过的代理列表（用于调试和排查） */
  triedProxies?: TriedProxy[]
  
  /** 代理警告信息（当所有代理失败并降级到直连时） */
  proxyWarning?: string
}

// ============================================
// 错误码定义
// ============================================

/**
 * 验证联盟链接 - 错误码枚举
 */
export enum AffiliateVerifyErrorCode {
  /** 参数校验失败 */
  VALIDATION_ERROR = 'VALIDATION_ERROR',
  
  /** 无效的 URL 格式 */
  INVALID_URL = 'INVALID_URL',
  
  /** 代理服务不可用 */
  PROXY_UNAVAILABLE = 'PROXY_UNAVAILABLE',
  
  /** 目标地址无法访问 */
  TARGET_UNREACHABLE = 'TARGET_UNREACHABLE',
  
  /** 重定向次数超限 */
  MAX_REDIRECTS_EXCEEDED = 'MAX_REDIRECTS_EXCEEDED',
  
  /** 请求超时 */
  TIMEOUT = 'TIMEOUT',
  
  /** SSL 证书错误 */
  SSL_ERROR = 'SSL_ERROR',
  
  /** 域名不匹配 */
  DOMAIN_MISMATCH = 'DOMAIN_MISMATCH',
  
  /** 内部错误 */
  INTERNAL_ERROR = 'INTERNAL_ERROR',
}

// ============================================
// 辅助类型（内部使用）
// ============================================

/**
 * 代理请求配置
 */
export interface ProxyRequestConfig {
  /** 代理出口 IP */
  proxyIp: string
  
  /** 代理协议 */
  protocol: 'http' | 'https' | 'socks5'
  
  /** 代理端口 */
  port: number
  
  /** 代理认证用户名 */
  username?: string
  
  /** 代理认证密码 */
  password?: string
}

/**
 * 域名验证结果
 */
export interface DomainValidationResult {
  /** 是否匹配 */
  matched: boolean
  
  /** 期望的目标域名 */
  expectedDomain: string
  
  /** 实际的最终域名 */
  actualDomain: string
  
  /** 不匹配原因（当 matched=false 时） */
  reason?: string
}

// ============================================
// 常量配置
// ============================================

/**
 * 默认配置值
 */
export const AFFILIATE_VERIFY_DEFAULTS = {
  /** 默认 Referer */
  referrer: 'https://t.co',
  
  /** 默认最大重定向次数 */
  maxRedirects: 10,
  
  /** 单次请求超时时间（毫秒）- 代理连接可能较慢，设置为 20 秒 */
  requestTimeout: 20000,
  
  /** 整体验证超时时间（毫秒） */
  totalTimeout: 60000,
} as const

