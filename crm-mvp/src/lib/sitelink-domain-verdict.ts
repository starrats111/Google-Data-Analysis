/**
 * D-350：站内链接的「域名归属」判定 —— 一处判据，两条路径共用。
 *
 * 背景（01 2026-09-23 报障）：商家 Veracity（联盟登记域 `veracityselfcare.com`）的站内链接
 * 全部是 AI 从商家平台爬出来的 `veracityhealth.co/...`，界面上链接 2～5 显示「已验证」，
 * 唯独链接 1（`veracityhealth.com/collections/...`）红着，报「链接域名与商家域名不匹配」。
 * 01 的判断是「这些链接虽然域名不一样但还是这个商家的，闸太死板」——查下来三个错叠在一起：
 *
 *   ① **基准选错**：前端那道闸取 `merchant.merchant_url || adCreative.final_url`，**商家域优先**。
 *      但 Google Ads 的实际要求是 sitelink 与**落地页 final_url** 同域，不是与联盟登记域同域。
 *      `merchant_url` 是联盟后台里填的那个（图一 Target URL = veracityselfcare.com），
 *      而落地页是巡航/生成阶段校正后的真实站点（D-1142 那段「压倒性主导域校正」会把
 *      `merchantUrl` 改写成候选链接集中的那个 host）。基准取反了，自然判不匹配。
 *
 *   ② **判据是裸字符串**：前端写的是 `urlDomain.includes(baseDomain) || baseDomain.includes(urlDomain)`，
 *      而后端 D-316/D-318 的 `landingMatchesTarget` 早就放行了这一组——
 *      `veracityhealth` 与 `veracityselfcare` 共同前缀 `veracity` = 8 ≥ SAME_ENTITY_PREFIX(6)。
 *      同一个判断，前端自己另写了一套更弱的，两边结论相反。
 *
 *   ③ **两条路径不一致**：自动爬取那条只调 `check-url`（纯可达性），**根本没有域名闸**，
 *      所以同域的链接 2～5 一路「已验证」；只有手动「验证」按钮走的
 *      `fetchAndValidateSitelink` 多套了 ① ② 这道闸，于是同一批链接里只有被点过的那条变红。
 *      这也是「其他都成功、第一条不成功」的直接原因，不是链接 1 本身有什么特别。
 *
 * 判法沿用 D-316→D-318→D-328 这条既有链路，不新造判据：
 *   1. 基准取 **final_url 优先、merchant_url 兜底**，两个都认（任一匹配即过）——
 *      落地页是 Google 的真实口径，商家域是它的上游来源，都属于「商家自己的域」。
 *   2. 先跑 `landingMatchesTarget`（同根域 / 换 ccTLD / 建站平台子域 / 共同前缀≥6）。
 *   3. 仍不过时，才抓一次页面让它自证（D-328 `checkLandingOwnership`），
 *      商家品牌段出现在 title/canonical/资源域里就放行——治「改名子品牌」那一类
 *      （Tapo vs TP-Link：字面判据全不成立，只有页面自己认）。
 *   4. 还是找不到 → 判 off_merchant，维持拦下。
 *
 * 取向与 D-316 一贯一致：**宁可漏判，不可错杀**。没有可比基准时放行（no_baseline），
 * 不拿「读不到商家域」当拒绝理由；但 off_merchant 仍然要拦——放行第三方中转域的代价是
 * 脏 URL 扩散进 ad_creatives.sitelinks 并被投到 Google（PartnerBoost 那类商家真下线的中转页即此）。
 */
import { landingMatchesTarget } from '@/lib/root-domain'
import { checkLandingOwnership } from '@/lib/landing-ownership'

export type SitelinkDomainVerdict =
  /** 字面判据即认定在商家域下（同根域 / 换 ccTLD / 平台子域 / 共同前缀≥6） */
  | 'on_merchant'
  /** 字面判据不认，但页面自证属于商家（D-328）→ 放行 */
  | 'self_certified'
  /** 没有任何可比基准（final_url 与 merchant_url 都取不到）→ 放行，不拿缺基准当拒绝理由 */
  | 'no_baseline'
  /** 字面不匹配且页面也证不出归属 → 拦下 */
  | 'off_merchant'

export interface SitelinkDomainResult {
  verdict: SitelinkDomainVerdict
  /** 命中的那个基准（供报错文案与日志用），no_baseline 时为空串 */
  matchedBaseline: string
  /** 判定链路上实际用到的判据，留痕用 */
  via: 'literal' | 'ownership' | 'none'
  /** D-328 自证时页面品牌段命中的位置，未走自证则为 null */
  hitIn: 'title' | 'canonical' | 'assetHost' | null
}

export interface JudgeSitelinkDomainOptions {
  /** 广告落地页 URL（ad_creatives.final_url）—— Google 的真实同域口径，优先 */
  finalUrl?: string | null
  /** 商家域（user_merchants.merchant_url）—— 兜底基准 */
  merchantUrl?: string | null
  /** 注入用，测试走这里；默认全局 fetch */
  fetchImpl?: typeof fetch
}

/**
 * 判断一条站内链接的域名是否属于该商家。
 *
 * @param sitelinkUrl 待判定的站内链接（完整 URL）
 */
export async function judgeSitelinkDomain(
  sitelinkUrl: string,
  opts: JudgeSitelinkDomainOptions,
): Promise<SitelinkDomainResult> {
  // final_url 优先：Google 要求 sitelink 与落地页同域，merchant_url 只是它的上游来源
  const baselines = [opts.finalUrl, opts.merchantUrl]
    .map((b) => (b || '').trim())
    .filter((b) => b.length > 0)

  if (baselines.length === 0) {
    return { verdict: 'no_baseline', matchedBaseline: '', via: 'none', hitIn: null }
  }

  // ── 第一道：D-316/D-318 字面判据（零网络开销，正常链接到此即过） ──
  for (const baseline of baselines) {
    if (landingMatchesTarget(sitelinkUrl, baseline)) {
      return { verdict: 'on_merchant', matchedBaseline: baseline, via: 'literal', hitIn: null }
    }
  }

  // ── 第二道：D-328 让页面自证归属 ──
  // 只在字面判据要拦下时才抓，正常链接不增加任何请求。治「改名子品牌」这类字面无关的误杀。
  for (const baseline of baselines) {
    const own = await checkLandingOwnership(sitelinkUrl, baseline, opts.fetchImpl ?? fetch)
    if (own.verdict === 'brand_hit_allow') {
      return { verdict: 'self_certified', matchedBaseline: baseline, via: 'ownership', hitIn: own.hitIn }
    }
  }

  return { verdict: 'off_merchant', matchedBaseline: baselines[0], via: 'ownership', hitIn: null }
}

/** 判定是否应放行。四态里只有 off_merchant 拦下。 */
export function sitelinkDomainAllowed(verdict: SitelinkDomainVerdict): boolean {
  return verdict !== 'off_merchant'
}
