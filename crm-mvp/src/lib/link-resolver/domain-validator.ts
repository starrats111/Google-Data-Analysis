/**
 * 域名验证器
 * 
 * 负责验证最终落地页域名是否与目标域名匹配
 * 支持精确匹配、子域名匹配、泛域名匹配
 * 支持二级后缀（co.uk, com.cn, com.au, co.jp 等）
 */

import type { DomainValidationResult } from './types'

// ============================================
// 二级后缀列表（常见的国家/地区二级域名）
// ============================================

/**
 * 常见的二级后缀列表
 * 这些后缀需要特殊处理，因为根域名需要包含三个部分
 * 例如：example.co.uk 的根域名是 example.co.uk，而不是 co.uk
 */
const SECOND_LEVEL_TLDS = new Set([
  // 英国
  'co.uk', 'org.uk', 'me.uk', 'net.uk', 'ltd.uk', 'plc.uk',
  // 中国
  'com.cn', 'net.cn', 'org.cn', 'gov.cn', 'edu.cn',
  // 香港
  'com.hk', 'org.hk', 'net.hk', 'edu.hk', 'gov.hk',
  // 台湾
  'com.tw', 'org.tw', 'net.tw', 'edu.tw', 'gov.tw',
  // 日本
  'co.jp', 'or.jp', 'ne.jp', 'ac.jp', 'go.jp',
  // 韩国
  'co.kr', 'or.kr', 'ne.kr', 'ac.kr', 'go.kr',
  // 澳大利亚
  'com.au', 'net.au', 'org.au', 'edu.au', 'gov.au',
  // 新西兰
  'co.nz', 'org.nz', 'net.nz', 'govt.nz',
  // 印度
  'co.in', 'org.in', 'net.in', 'gov.in', 'ac.in',
  // 巴西
  'com.br', 'org.br', 'net.br', 'gov.br', 'edu.br',
  // 俄罗斯
  'com.ru', 'org.ru', 'net.ru',
  // 南非
  'co.za', 'org.za', 'net.za', 'gov.za',
  // 其他
  'com.sg', 'org.sg', 'net.sg', 'gov.sg', // 新加坡
  'com.my', 'org.my', 'net.my', 'gov.my', // 马来西亚
  'co.th', 'or.th', 'ac.th', 'go.th',     // 泰国
  'com.vn', 'org.vn', 'net.vn', 'gov.vn', // 越南
  'co.id', 'or.id', 'ac.id', 'go.id',     // 印尼
  'com.ph', 'org.ph', 'net.ph', 'gov.ph', // 菲律宾
  'com.mx', 'org.mx', 'net.mx', 'gob.mx', // 墨西哥
  'com.ar', 'org.ar', 'net.ar', 'gob.ar', // 阿根廷
])

// ============================================
// 验证器接口定义
// ============================================

/**
 * 域名验证器接口
 */
export interface IDomainValidator {
  /**
   * 验证域名是否匹配
   * @param actualDomain 实际的最终域名
   * @param targetDomain 期望的目标域名
   * @returns 验证结果
   */
  validate(actualDomain: string, targetDomain: string): DomainValidationResult
}

/**
 * 验证模式枚举
 */
export enum ValidationMode {
  /** 精确匹配：域名必须完全相同 */
  EXACT = 'exact',
  
  /** 子域名匹配：允许子域名（如 www.example.com 匹配 example.com） */
  SUBDOMAIN = 'subdomain',
  
  /** 泛域名匹配：忽略 www 前缀 */
  WILDCARD = 'wildcard',
}

/**
 * 验证器配置选项
 */
export interface ValidatorOptions {
  /** 验证模式（默认 subdomain） */
  mode?: ValidationMode
  
  /** 是否忽略大小写（默认 true） */
  ignoreCase?: boolean
  
  /** 是否忽略 www 前缀（默认 true） */
  ignoreWww?: boolean
  
  /** 允许的额外域名列表（白名单） */
  allowedDomains?: string[]
}

/**
 * validateDomain 函数的返回类型
 */
export interface DomainValidateResult {
  /** 域名是否匹配 */
  isValid: boolean
  
  /** 目标根域名（标准化后） */
  targetDomain: string
  
  /** 实际根域名（从 finalUrl 提取） */
  actualDomain: string
  
  /** 最终落地页 URL */
  finalUrl: string
}

// ============================================
// 核心工具函数
// ============================================

/**
 * 从 URL 中提取根域名
 * 支持二级后缀（co.uk, com.cn, com.au, co.jp 等）
 * 
 * @param url 完整的 URL 或域名
 * @returns 根域名，如果 URL 无效则返回 null
 * 
 * @example
 * extractRootDomain('https://www.example.co.uk/path') // 'example.co.uk'
 * extractRootDomain('https://sub.domain.example.com') // 'example.com'
 * extractRootDomain('https://192.168.1.1/path')       // '192.168.1.1'（IP 地址原样返回）
 * extractRootDomain('invalid-url')                     // null
 */
export function extractRootDomain(url: string): string | null {
  // 空值检查
  if (!url || typeof url !== 'string') {
    return null
  }

  let hostname: string

  try {
    // 尝试作为完整 URL 解析
    // 如果 url 不包含协议，先添加一个
    const urlToParse = url.includes('://') ? url : `https://${url}`
    const urlObj = new URL(urlToParse)
    hostname = urlObj.hostname
  } catch {
    // URL 解析失败，尝试直接作为域名处理
    // 移除可能的路径和端口
    hostname = url.split('/')[0].split(':')[0].trim()
    
    // 如果还是无效，返回 null
    if (!hostname || hostname.length === 0) {
      return null
    }
  }

  // 转小写
  hostname = hostname.toLowerCase()

  // 检查是否为 IP 地址（IPv4）
  const ipv4Regex = /^(\d{1,3}\.){3}\d{1,3}$/
  if (ipv4Regex.test(hostname)) {
    return hostname
  }

  // 域名格式基本校验：必须包含 . 或者是有效的 IP 地址
  // 排除单词类的无效输入（如 "not-valid"）
  if (!hostname.includes('.')) {
    return null
  }

  // 检查是否为 IPv6 地址
  if (hostname.startsWith('[') || hostname.includes(':')) {
    return hostname
  }

  // 分割域名
  const parts = hostname.split('.')
  
  // 单个部分（如 localhost）直接返回
  if (parts.length === 1) {
    return hostname
  }

  // 检查是否为二级后缀
  if (parts.length >= 2) {
    const lastTwo = parts.slice(-2).join('.')
    
    if (SECOND_LEVEL_TLDS.has(lastTwo)) {
      // 二级后缀：需要取最后三个部分作为根域名
      if (parts.length >= 3) {
        return parts.slice(-3).join('.')
      }
      // 如果只有两个部分且是二级后缀，说明格式不完整
      return hostname
    }
  }

  // 普通域名：取最后两个部分
  if (parts.length >= 2) {
    return parts.slice(-2).join('.')
  }

  return hostname
}

/**
 * 标准化域名
 * 去除 www 前缀、转小写、去除首尾空格
 * 
 * @param domain 原始域名
 * @returns 标准化后的域名
 * 
 * @example
 * normalizeDomain('WWW.Example.COM')  // 'example.com'
 * normalizeDomain('www.example.com')  // 'example.com'
 * normalizeDomain('  example.com  ')  // 'example.com'
 * normalizeDomain('Example.COM')      // 'example.com'
 */
export function normalizeDomain(domain: string): string {
  if (!domain || typeof domain !== 'string') {
    return ''
  }

  // 去除首尾空格，转小写
  let normalized = domain.trim().toLowerCase()

  // 移除 www 前缀（支持 www. 开头）
  if (normalized.startsWith('www.')) {
    normalized = normalized.slice(4)
  }

  return normalized
}

/**
 * 验证最终 URL 的域名是否与目标域名匹配
 * 两边都提取根域名后再进行比较
 * 
 * @param finalUrl 最终落地页的完整 URL
 * @param targetDomain 期望的目标域名（可以是完整域名或根域名）
 * @returns 验证结果对象
 * 
 * @example
 * // 基本匹配
 * validateDomain('https://www.example.com/page', 'example.com')
 * // { isValid: true, targetDomain: 'example.com', actualDomain: 'example.com', finalUrl: '...' }
 * 
 * // 二级后缀
 * validateDomain('https://shop.example.co.uk/item', 'example.co.uk')
 * // { isValid: true, targetDomain: 'example.co.uk', actualDomain: 'example.co.uk', finalUrl: '...' }
 */
export function validateDomain(finalUrl: string, targetDomain: string): DomainValidateResult {
  // 从 finalUrl 提取根域名
  const extractedActual = extractRootDomain(finalUrl)
  const actualDomain = extractedActual ? normalizeDomain(extractedActual) : ''

  // 从 targetDomain 提取根域名（targetDomain 可能是完整域名或 URL）
  const extractedTarget = extractRootDomain(targetDomain)
  const normalizedTarget = extractedTarget ? normalizeDomain(extractedTarget) : normalizeDomain(targetDomain)

  // 比较两个根域名
  const isValid = actualDomain !== '' && normalizedTarget !== '' && actualDomain === normalizedTarget

  return {
    isValid,
    targetDomain: normalizedTarget,
    actualDomain,
    finalUrl,
  }
}

// ============================================
// 验证器类
// ============================================

/**
 * 域名验证器类
 */
export class DomainValidator implements IDomainValidator {
  private options: Required<ValidatorOptions>

  constructor(options: ValidatorOptions = {}) {
    this.options = {
      mode: options.mode ?? ValidationMode.SUBDOMAIN,
      ignoreCase: options.ignoreCase ?? true,
      ignoreWww: options.ignoreWww ?? true,
      allowedDomains: options.allowedDomains ?? [],
    }
  }

  /**
   * 验证域名是否匹配
   */
  validate(actualDomain: string, targetDomain: string): DomainValidationResult {
    // 标准化域名
    const actual = this.normalizeForValidation(actualDomain)
    const target = this.normalizeForValidation(targetDomain)

    // 检查白名单
    if (this.isInAllowedList(actual)) {
      return {
        matched: true,
        expectedDomain: targetDomain,
        actualDomain: actualDomain,
      }
    }

    // 根据验证模式进行匹配
    let matched = false
    let reason: string | undefined

    switch (this.options.mode) {
      case ValidationMode.EXACT:
        matched = actual === target
        if (!matched) {
          reason = `域名不完全匹配：期望 "${target}"，实际 "${actual}"`
        }
        break

      case ValidationMode.SUBDOMAIN:
        matched = actual === target || actual.endsWith(`.${target}`)
        if (!matched) {
          reason = `域名不匹配（包含子域名）：期望 "${target}" 或其子域名，实际 "${actual}"`
        }
        break

      case ValidationMode.WILDCARD:
        matched = this.wildcardMatch(actual, target)
        if (!matched) {
          reason = `域名不匹配：期望 "${target}"，实际 "${actual}"`
        }
        break
    }

    return {
      matched,
      expectedDomain: targetDomain,
      actualDomain: actualDomain,
      reason,
    }
  }

  /**
   * 标准化域名（内部使用）
   */
  private normalizeForValidation(domain: string): string {
    let normalized = domain.trim()

    // 转小写
    if (this.options.ignoreCase) {
      normalized = normalized.toLowerCase()
    }

    // 移除 www 前缀
    if (this.options.ignoreWww && normalized.startsWith('www.')) {
      normalized = normalized.slice(4)
    }

    return normalized
  }

  /**
   * 检查是否在白名单中
   */
  private isInAllowedList(domain: string): boolean {
    return this.options.allowedDomains.some(allowed => {
      const normalizedAllowed = this.normalizeForValidation(allowed)
      return domain === normalizedAllowed || domain.endsWith(`.${normalizedAllowed}`)
    })
  }

  /**
   * 泛域名匹配
   */
  private wildcardMatch(actual: string, target: string): boolean {
    // 移除可能的通配符前缀
    const cleanTarget = target.startsWith('*.') ? target.slice(2) : target

    return actual === cleanTarget || actual.endsWith(`.${cleanTarget}`)
  }
}

// ============================================
// 兼容性工具函数（保留原有导出）
// ============================================

/**
 * 提取基础域名（extractRootDomain 的别名）
 * @deprecated 请使用 extractRootDomain
 */
export function extractBaseDomain(domain: string): string {
  return extractRootDomain(domain) ?? domain
}

/**
 * 验证域名格式是否有效
 */
export function isValidDomain(domain: string): boolean {
  // 基本域名格式正则
  const domainRegex = /^(?:[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?\.)+[a-zA-Z]{2,}$/
  return domainRegex.test(domain)
}

/**
 * 比较两个域名是否属于同一主域
 */
export function isSameBaseDomain(domain1: string, domain2: string): boolean {
  const root1 = extractRootDomain(domain1)
  const root2 = extractRootDomain(domain2)
  return root1 !== null && root2 !== null && root1 === root2
}

// ============================================
// 测试用例（可在控制台运行验证）
// ============================================

/**
 * 测试用例集合
 * 运行方式：在 Node.js 环境导入此模块后调用 runDomainValidatorTests()
 */
export function runDomainValidatorTests(): void {
  console.log('=== 域名验证器测试用例 ===\n')

  const testCases = [
    // 用例 1: 基本 www 前缀处理
    {
      name: '用例 1: www 前缀 - finalUrl 带 www',
      finalUrl: 'https://www.example.com/landing/page?ref=abc',
      targetDomain: 'example.com',
      expected: { isValid: true, targetDomain: 'example.com', actualDomain: 'example.com' },
    },
    
    // 用例 2: 二级后缀 co.uk
    {
      name: '用例 2: 二级后缀 - co.uk',
      finalUrl: 'https://shop.example.co.uk/products/123',
      targetDomain: 'example.co.uk',
      expected: { isValid: true, targetDomain: 'example.co.uk', actualDomain: 'example.co.uk' },
    },
    
    // 用例 3: 二级后缀 com.cn
    {
      name: '用例 3: 二级后缀 - com.cn（带 www）',
      finalUrl: 'https://www.taobao.com.cn/item/detail',
      targetDomain: 'taobao.com.cn',
      expected: { isValid: true, targetDomain: 'taobao.com.cn', actualDomain: 'taobao.com.cn' },
    },
    
    // 用例 4: IP 地址
    {
      name: '用例 4: IP 地址',
      finalUrl: 'http://192.168.1.100:8080/api/test',
      targetDomain: '192.168.1.100',
      expected: { isValid: true, targetDomain: '192.168.1.100', actualDomain: '192.168.1.100' },
    },
    
    // 用例 5: 无效 URL
    {
      name: '用例 5: 无效 URL',
      finalUrl: 'not-a-valid-url-at-all',
      targetDomain: 'example.com',
      expected: { isValid: false, targetDomain: 'example.com', actualDomain: '' },
    },
    
    // 用例 6: targetDomain 带 www 前缀
    {
      name: '用例 6: targetDomain 带 www 前缀',
      finalUrl: 'https://sub.example.com/page',
      targetDomain: 'www.example.com',
      expected: { isValid: true, targetDomain: 'example.com', actualDomain: 'example.com' },
    },
    
    // 用例 7: targetDomain 本身是根域名
    {
      name: '用例 7: targetDomain 本身是根域名',
      finalUrl: 'https://blog.amazon.com/news',
      targetDomain: 'amazon.com',
      expected: { isValid: true, targetDomain: 'amazon.com', actualDomain: 'amazon.com' },
    },
    
    // 用例 8: 域名不匹配
    {
      name: '用例 8: 域名不匹配',
      finalUrl: 'https://www.google.com/search',
      targetDomain: 'amazon.com',
      expected: { isValid: false, targetDomain: 'amazon.com', actualDomain: 'google.com' },
    },
    
    // 用例 9: 二级后缀 com.au
    {
      name: '用例 9: 二级后缀 - com.au',
      finalUrl: 'https://www.news.com.au/national/story',
      targetDomain: 'news.com.au',
      expected: { isValid: true, targetDomain: 'news.com.au', actualDomain: 'news.com.au' },
    },
    
    // 用例 10: 二级后缀 co.jp
    {
      name: '用例 10: 二级后缀 - co.jp（子域名）',
      finalUrl: 'https://store.rakuten.co.jp/shop/item',
      targetDomain: 'www.rakuten.co.jp',
      expected: { isValid: true, targetDomain: 'rakuten.co.jp', actualDomain: 'rakuten.co.jp' },
    },
  ]

  let passed = 0
  let failed = 0

  for (const tc of testCases) {
    const result = validateDomain(tc.finalUrl, tc.targetDomain)
    const isPass = 
      result.isValid === tc.expected.isValid &&
      result.targetDomain === tc.expected.targetDomain &&
      result.actualDomain === tc.expected.actualDomain

    if (isPass) {
      console.log(`✅ ${tc.name}`)
      passed++
    } else {
      console.log(`❌ ${tc.name}`)
      console.log(`   期望: ${JSON.stringify(tc.expected)}`)
      console.log(`   实际: ${JSON.stringify({ isValid: result.isValid, targetDomain: result.targetDomain, actualDomain: result.actualDomain })}`)
      failed++
    }
  }

  console.log(`\n=== 测试结果: ${passed} 通过, ${failed} 失败 ===`)
}
