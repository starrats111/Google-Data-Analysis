/**
 * 单条 suffix 生成器
 *
 * 复用 CRM 现有成熟基础设施 affiliate-link-resolver（按投放国走住宅轮换代理跟随联盟链接
 * 整条重定向链，含 meta/js 跳转提取、App 深链解包、跳板域名识别），取最终落地页的 query 串
 * 作为 Google Ads 的 finalUrlSuffix。
 *
 * 住宅代理为 rotating gateway，每次连接自动换出口 IP → 联盟平台生成新的 clickid → 同一商家
 * 多次生成得到互不相同的 suffix，正是换链接所需。
 */

import { resolveAffiliateLink } from '@/lib/affiliate-link-resolver'
import { STOCK_CONFIG } from './config'

export type GenFailReason = 'no_tracking' | 'forbidden_network' | 'resolve_failed' | 'timeout' | 'bad_input'

export interface GenSuccess {
  ok: true
  suffix: string
  finalUrl: string | null
}

export interface GenFailure {
  ok: false
  reason: GenFailReason
  error: string
  finalUrl?: string | null
}

export type GenResult = GenSuccess | GenFailure

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('GEN_TIMEOUT')), ms)
    p.then(
      (v) => {
        clearTimeout(timer)
        resolve(v)
      },
      (e) => {
        clearTimeout(timer)
        reject(e)
      },
    )
  })
}

/**
 * 生成单条 suffix。
 * @param affiliateUrl 商家联盟追踪链接（user_merchants.tracking_link）
 * @param country 投放国（campaigns.target_country），决定代理出口国
 * @param platform 联盟平台代号（用于上级联盟黑名单判定）
 */
export async function generateOneSuffix(
  affiliateUrl: string,
  country: string,
  platform: string | null,
  opts: { userId?: bigint | null; userAgent?: string | null; referer?: string | null } = {},
): Promise<GenResult> {
  if (!affiliateUrl || !/^https?:\/\//i.test(affiliateUrl)) {
    return { ok: false, reason: 'bad_input', error: '联盟链接为空或格式不合法' }
  }

  try {
    const r = await withTimeout(
      resolveAffiliateLink(affiliateUrl, country || 'US', platform, {
        useBrowser: false,
        userId: opts.userId,
        userAgent: opts.userAgent,
        referer: opts.referer,
      }),
      STOCK_CONFIG.GEN_TIMEOUT_MS,
    )

    if (r.status === 'ok' && r.trackingLink) {
      return { ok: true, suffix: r.trackingLink, finalUrl: r.finalUrl }
    }
    if (r.status === 'no_tracking') {
      return {
        ok: false,
        reason: 'no_tracking',
        error: '跟链成功但落地页无追踪参数，无法生成 suffix',
        finalUrl: r.finalUrl,
      }
    }
    if (r.status === 'forbidden_network') {
      return {
        ok: false,
        reason: 'forbidden_network',
        error: `命中上级联盟黑名单：${r.forbiddenKeyword ?? '未知'}`,
        finalUrl: r.finalUrl,
      }
    }
    return {
      ok: false,
      reason: 'resolve_failed',
      error: r.error || '跟链失败，未跟到广告主落地页',
      finalUrl: r.finalUrl,
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    if (msg === 'GEN_TIMEOUT') {
      return { ok: false, reason: 'timeout', error: `生成超时（>${STOCK_CONFIG.GEN_TIMEOUT_MS}ms）` }
    }
    return { ok: false, reason: 'resolve_failed', error: msg.slice(0, 200) }
  }
}
