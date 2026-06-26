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
import { getUsedExitIps, acquireDedupedProxy } from './exit-ip'

export type GenFailReason = 'no_tracking' | 'forbidden_network' | 'resolve_failed' | 'timeout' | 'bad_input'

export interface GenSuccess {
  ok: true
  suffix: string
  finalUrl: string | null
  /** 生成该后缀时代理出口 IP（去重场景写入 suffix_pool.exit_ip / proxy_exit_ip_usage） */
  exitIp: string | null
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
  opts: {
    userId?: bigint | null
    /** 传入时启用「按系列 24h 出口 IP 去重」并把出口 IP 记到结果，供调用方落库 */
    campaignId?: bigint | null
    userAgent?: string | null
    referer?: string | null
  } = {},
): Promise<GenResult> {
  if (!affiliateUrl || !/^https?:\/\//i.test(affiliateUrl)) {
    return { ok: false, reason: 'bad_input', error: '联盟链接为空或格式不合法' }
  }

  // 出口 IP 去重：仅在带 campaignId+userId 时启用（补货/刷点击路径）。
  // 取一个「24h 内该系列未用过」的粘性会话代理，探到的出口 IP 与后续生成复用同一会话。
  let proxyUrl: string | null | undefined = undefined
  let exitIp: string | null = null
  if (opts.campaignId && opts.userId) {
    try {
      const usedIps = await getUsedExitIps(opts.userId, opts.campaignId)
      const picked = await acquireDedupedProxy(country || 'US', {
        userId: opts.userId,
        campaignId: opts.campaignId,
        usedIps,
      })
      proxyUrl = picked.proxyUrl ?? undefined
      exitIp = picked.exitIp
    } catch {
      // 去重链路异常不阻断换链，降级走 resolver 内部取代理
    }
  }

  try {
    const r = await withTimeout(
      resolveAffiliateLink(affiliateUrl, country || 'US', platform, {
        useBrowser: false,
        // 轻量抓取拿不到追踪参数 / 停跳板时，自动用无头浏览器重试一次
        // （pepperjam/impact/ultrainfluence 等需真实浏览器执行 JS 才会附加 clickId/utm）
        browserFallback: true,
        userId: opts.userId,
        userAgent: opts.userAgent,
        referer: opts.referer,
        proxyUrl,
      }),
      STOCK_CONFIG.GEN_TIMEOUT_MS,
    )

    if (r.status === 'ok' && r.trackingLink) {
      return { ok: true, suffix: r.trackingLink, finalUrl: r.finalUrl, exitIp }
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
