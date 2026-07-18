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
import { getUsedExitIps, acquireDedupedProxy, probeExitIp, type DedupScope } from './exit-ip'
import { reportProviderResult, PROXY_HARD_ERR } from './proxy-circuit'

export type GenFailReason =
  | 'no_tracking'
  | 'forbidden_network'
  | 'resolve_failed'
  | 'timeout'
  | 'bad_input'
  // 联盟跳板在自己的重定向端点 4xx 拒绝点击（403 等）：链接失效/被停用，需人工重新获取。
  // 与 no_tracking 区分——no_tracking 是「到站了但页面没参数」，此项是「点击根本没登记」。
  | 'tracker_forbidden'
  // D-177：换链接代理不可用（kookeey 余额耗尽/熔断/供应商池空）。瞬时环境故障，
  // 不代表链接死活——调用方短冷却重试即可，绝不计入死链失败计数/invalid_link 告警。
  | 'proxy_unavailable'

export interface GenSuccess {
  ok: true
  suffix: string
  finalUrl: string | null
  /** 生成该后缀时代理出口 IP（去重场景写入 suffix_pool.exit_ip / proxy_exit_ip_usage） */
  exitIp: string | null
  /** 本条是否走了无头浏览器兜底才成功（纯 HTTP 跟不到、必须执行 JS）。
   *  用于「必须浏览器的系列降频补货」——浏览器整页加载是纯 HTTP 的几十倍流量。 */
  usedBrowser: boolean
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
    /** 传入时启用代理选择/出口 IP 记录（补货/刷点击路径） */
    campaignId?: bigint | null
    /** F-IPDEDUP-01：组级去重键。三者(team+platform+merchant)齐全才启用「跨用户不跨组 + /24 段」去重 */
    teamId?: bigint | null
    merchantId?: string | null
    userAgent?: string | null
    referer?: string | null
  } = {},
): Promise<GenResult> {
  if (!affiliateUrl || !/^https?:\/\//i.test(affiliateUrl)) {
    return { ok: false, reason: 'bad_input', error: '联盟链接为空或格式不合法' }
  }

  // 组级去重键（跨用户、不跨组）。返回给调用方复用于 recordExitIp，保证「取/记」同键。
  const dedupScope: DedupScope = {
    teamId: opts.teamId ?? null,
    platform: platform ?? null,
    merchantId: opts.merchantId ?? null,
    userId: opts.userId ?? null,
    campaignId: opts.campaignId ?? null,
  }

  // 出口 IP 去重 + 代理选择：仍以「带 campaignId+userId」为触发（补货/刷点击路径）。
  // 组级去重集合按 (team,platform,merchant) 取；缺组信息(如未分组)时集合为空 → 退化为纯代理选择、不去重。
  let proxyUrl: string | null | undefined = undefined
  let exitIp: string | null = null
  // 本次选中的供应商 id（用于向熔断器归因成败）；走 env/模板兜底或无供应商时为 null。
  let selectedProviderId: string | null = null
  if (opts.campaignId && opts.userId) {
    try {
      const used = await getUsedExitIps(dedupScope)
      const picked = await acquireDedupedProxy(country || 'US', {
        userId: opts.userId,
        used,
      })
      proxyUrl = picked.proxyUrl ?? undefined
      exitIp = picked.exitIp
      selectedProviderId = picked.providerId
    } catch {
      // 去重链路异常不阻断换链，降级走 resolver 内部取代理
    }
  }

  // 熔断器归因（A+B 之 B）：仅对「硬代理错误」判失败，其余（no_tracking/黑名单/慢站超时）
  // 都算代理可用——它已把请求送达联盟/落地页，失败在下游而非代理本身。
  const reportProxy = (ok: boolean) => {
    if (selectedProviderId) reportProviderResult(selectedProviderId, ok)
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
      // 出口 IP 记录（修复「success 无 exit_ip」）：
      //   1) 优先 resolver 回传的实际点击出口（浏览器兜底 / 内部自取代理路径）；
      //   2) 否则用本函数预探测的粘性会话 IP（纯 HTTP 复用同一会话，二者一致）；
      //   3) 兜底：粘性会话存在但预探测当时失败 → 补探一次同会话（浏览器路径除外，其出口代理不同）。
      let finalExitIp: string | null = r.exitIp ?? exitIp
      if (!finalExitIp && !r.usedBrowser && proxyUrl) finalExitIp = await probeExitIp(proxyUrl)
      reportProxy(true) // 代理健康：成功跟到落地页并取到追踪参数
      return { ok: true, suffix: r.trackingLink, finalUrl: r.finalUrl, exitIp: finalExitIp, usedBrowser: r.usedBrowser }
    }
    if (r.status === 'tracker_forbidden') {
      reportProxy(true) // 代理健康：请求已送达跳板，是跳板自己 4xx 拒绝（非代理故障）
      return {
        ok: false,
        reason: 'tracker_forbidden',
        error: r.error || '联盟跳板拒绝点击（HTTP 4xx），追踪链接可能已失效，需人工重新获取',
        finalUrl: r.finalUrl,
      }
    }
    if (r.status === 'no_tracking') {
      reportProxy(true) // 代理健康：已到落地页，只是页面无追踪参数（下游问题）
      return {
        ok: false,
        reason: 'no_tracking',
        error: '跟链成功但落地页无追踪参数，无法生成 suffix',
        finalUrl: r.finalUrl,
      }
    }
    if (r.status === 'forbidden_network') {
      reportProxy(true) // 代理健康：命中上级联盟黑名单属业务判定，非代理故障
      return {
        ok: false,
        reason: 'forbidden_network',
        error: `命中上级联盟黑名单：${r.forbiddenKeyword ?? '未知'}`,
        finalUrl: r.finalUrl,
      }
    }
    const resolveErr = r.error || '跟链失败，未跟到广告主落地页'
    // D-177：代理不可用（resolver 未发起任何真实跟链）→ 单列瞬时错误，不归因代理熔断也不算链接失败
    if (resolveErr.startsWith('proxy_unavailable')) {
      return { ok: false, reason: 'proxy_unavailable', error: resolveErr, finalUrl: null }
    }
    // 仅当错误是硬代理错误（SOCKS5 认证失败/连接被拒/reset）才判代理失败，避免误伤
    reportProxy(!PROXY_HARD_ERR.test(resolveErr))
    return {
      ok: false,
      reason: 'resolve_failed',
      error: resolveErr,
      finalUrl: r.finalUrl,
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    if (msg === 'GEN_TIMEOUT') {
      // 超时不归因代理（慢目标站也会超时），保持中性不上报
      return { ok: false, reason: 'timeout', error: `生成超时（>${STOCK_CONFIG.GEN_TIMEOUT_MS}ms）` }
    }
    if (PROXY_HARD_ERR.test(msg)) reportProxy(false)
    return { ok: false, reason: 'resolve_failed', error: msg.slice(0, 200) }
  }
}
