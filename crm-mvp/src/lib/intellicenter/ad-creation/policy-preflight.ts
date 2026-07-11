/**
 * C-112 / D-046.C — Step 4：政策 Pre-flight 闸门
 *
 * 输入：
 *   - 画像（compliance_risk_level / trademark_authorization_status / requires_certification）
 *   - 商家 ID（用来查 policy_violations 历史拒登）
 *   - 国家 / 广告类型
 *
 * 输出：PreflightResult{
 *   approved: 是否允许进入文案生成
 *   blocking_reasons: 阻断原因（X8=B 同类型 ≥3 次拒登 / compliance_risk_level=blocked）
 *   warnings: 警告（仅作 emitSSE 提示，不阻断）
 *   injectedConstraints: 注入给 AI prompt 的英文段落（healthcare 加 FDA 披露等）
 *   blockedKeywords: 黑名单（在 keyword-intelligence 里过滤掉）
 *   recommendedTone: 建议语气
 * }
 *
 * 07 决策：
 *   - X8=B 同类型拒登 ≥3 次阻断
 *   - 不阻断时仍生成所有可注入约束
 */

import prisma from "@/lib/prisma";
import { matchProhibitedBusinessCategory } from "@/lib/ai-rule-profile";
import { isBrandOwnDomain } from "@/lib/country-url-resolver";
import type {
  MerchantIntelligenceProfile,
  IndustryCategory,
} from "@/lib/intellicenter/merchant-profile/types";

const REJECTED_THRESHOLD_FOR_BLOCK = 3; // X8=B 同类型拒登 ≥3 次阻断
const REJECTED_HISTORY_DAYS = 90; // 仅看近 90 天历史

export type AdType =
  | "rsa"
  | "sitelink"
  | "callout"
  | "snippet"
  | "promotion"
  | "price";

export interface PreflightContext {
  merchantId: bigint;
  merchantName: string;
  finalUrl: string;
  targetCountry: string;
  adType: AdType;
  profile: MerchantIntelligenceProfile;
  /** D-062：落地页正文（截断），用于类目级受限/禁止业务识别（与画像核心字段互补） */
  businessText?: string;
}

export interface PreflightResult {
  approved: boolean;
  blocking_reasons: string[];
  warnings: string[];
  /** 注入到 AI prompt 的英文段落 */
  injectedConstraints: string;
  /** 文案/关键词黑名单（关键词引擎 + 生成后 linter 都要过滤） */
  blockedKeywords: string[];
  /** 必须包含的披露文本（如 "Use only as directed"） */
  requiredDisclosures: string[];
  /** 建议语气 */
  recommendedTone: "conservative" | "professional" | "casual" | "energetic";
  /** 商标策略 */
  trademarkPolicy: "block_brand" | "allow_with_authz" | "free";
  /** 内部诊断：近 90 天该商家被拒登 case 数 */
  recentRejectionCount: number;
}

/** 32 行业的政策注入规则（覆盖 Google Ads 4 大类常见限制） */
const INDUSTRY_RULES: Partial<
  Record<
    IndustryCategory,
    {
      tone: PreflightResult["recommendedTone"];
      constraints: string;
      requiredDisclosures: string[];
      blockedKeywords: string[];
    }
  >
> = {
  Healthcare_Pharmacy: {
    tone: "professional",
    constraints:
      "Healthcare/Pharmacy ad. (1) NEVER claim 'cure', 'treat', 'guaranteed results', 'miracle', 'FDA-approved' unless certified. (2) Country US → include FDA disclaimer style; UK → MHRA; AU → TGA. (3) Avoid before/after weight loss claims. (4) No personal testimonials presented as typical results. (5) No prescription drug names in headlines.",
    requiredDisclosures: ["Use as directed", "Consult a healthcare professional"],
    blockedKeywords: [
      "cure",
      "miracle",
      "guaranteed",
      "fda approved",
      "doctor recommended",
      "lose weight fast",
    ],
  },
  Finance_Insurance: {
    tone: "conservative",
    constraints:
      "Finance/Insurance ad. (1) NEVER use 'guaranteed profit', 'risk-free', '100% return', 'no risk'. (2) Required: include APR/fee disclosure if mentioning loans/credit. (3) Avoid 'instant cash', 'no credit check'. (4) Tone must be factual and conservative.",
    requiredDisclosures: ["Terms apply"],
    blockedKeywords: [
      "guaranteed profit",
      "risk-free",
      "100% return",
      "no risk",
      "get rich",
      "instant cash",
    ],
  },
  Gambling: {
    tone: "conservative",
    constraints:
      "Gambling ad. (1) Country-restricted; check Google Ads gambling allowlist. (2) Must include 'play responsibly' style disclosure. (3) No claims of 'guaranteed win'. (4) No targeting minors.",
    requiredDisclosures: ["Play responsibly", "18+"],
    blockedKeywords: ["guaranteed win", "easy money", "free money"],
  },
  Mature_Adult: {
    tone: "professional",
    constraints:
      "Adult/Mature category. (1) Country-restricted; many countries fully prohibit. (2) Remove suggestive language. (3) Age-gating compliance required.",
    requiredDisclosures: ["18+", "Age verification required"],
    blockedKeywords: ["sex", "nude", "xxx", "porn"],
  },
  Dating_Services: {
    tone: "casual",
    constraints:
      "Dating services. (1) No sexually suggestive language. (2) No false claims about user counts. (3) Tone friendly but never adult.",
    requiredDisclosures: [],
    blockedKeywords: ["hookup", "casual sex", "one night"],
  },
  Legal_Services: {
    tone: "professional",
    constraints:
      "Legal services. (1) No 'guaranteed outcome' claims. (2) Avoid 'best lawyer' superlatives. (3) Local bar association disclosure may apply.",
    requiredDisclosures: ["No guarantee of outcome"],
    blockedKeywords: ["guaranteed win", "best lawyer", "we always win"],
  },
};

export async function policyPreflight(
  ctx: PreflightContext,
): Promise<PreflightResult> {
  const blocking: string[] = [];
  const warnings: string[] = [];
  const constraintsParts: string[] = [];
  const requiredDisclosures: string[] = [];
  const blockedKeywords: string[] = [];

  // 1) 画像 blocked → 直接阻断
  if (ctx.profile.compliance_risk_level === "blocked") {
    blocking.push(
      `画像评估结果为 blocked（疑似 counterfeit / dangerous_products / illegal）。商家：${ctx.merchantName}`,
    );
  }

  // 1.5) D-062：类目级受限/禁止业务早期识别（Mindbloom=氯胺酮案例）。
  // 商家核心业务本身即受限品（管制物质/大麻CBD/武器）时，文案无论怎么改写都会撞提交硬卡，
  // 应在生成早期阻断并清晰告知，避免员工白生成一整套再被「AI 设定硬规则」拦下。
  // 优先扫画像蒸馏出的核心业务字段（高置信），再叠加落地页正文兜底。
  const profileCoreText = [
    ctx.merchantName,
    ctx.profile.industry_subcategory ?? "",
    (ctx.profile.business_profile?.main_products ?? []).join(" "),
    ctx.profile.brand_assets?.slogan ?? "",
    (ctx.profile.brand_assets?.usp ?? []).join(" "),
  ].join("  ");
  const coreHit = matchProhibitedBusinessCategory(profileCoreText);
  const textHit = coreHit ?? matchProhibitedBusinessCategory((ctx.businessText ?? "").slice(0, 12000));
  if (textHit) {
    const confidenceNote = coreHit
      ? "（依据画像识别出的核心业务）"
      : "（依据落地页正文，若判断有误请核对商家网址/画像）";
    blocking.push(
      `该商家核心业务属于 Google Ads 受限/禁止类目：${textHit.cn}${confidenceNote}。` +
        `此类商家的广告文案无论如何改写都会被硬性合规规则拦截（提交时同样会被「AI 设定硬规则」拦下），` +
        `系统已在生成早期阻断以免做无用功。处理建议：① 确认该商家是否真属此类目；` +
        `② 如确属，需先在 Google Ads 后台完成对应类目认证/白名单后由人工投放，或将该商家下架，系统不自动生成文案。`,
    );
  }

  // 2) 高风险画像 → 警告 + 注入更严格 prompt
  if (ctx.profile.compliance_risk_level === "high") {
    warnings.push(
      `高风险品类（compliance_risk_level=high）。AI 将自动使用保守语气并加额外披露。`,
    );
    constraintsParts.push(
      "HIGH-RISK MERCHANT: apply conservative tone, avoid superlatives ('best/#1/award-winning'), prefer factual claims over emotional ones, never use urgency words like 'now/today/limited time' unless backed by real promo.",
    );
  }

  // 3) 商标策略
  // 矫枉过正修复（Wellfit 实证）：画像的 trademark_authorization_status 是 AI 猜的且默认
  // unauthorized，导致「落地页就是品牌官网」的常规联盟单也被 block_brand 误杀。
  // 改用两个确定性信号取代 AI 猜测：
  //   ① 近 90 天有商标类真实拒登记录 → 无条件 block_brand（真实信号最高优先级）
  //   ② 无商标拒登 且 品牌词=落地域名（isBrandOwnDomain）→ free（品牌自有站推定）
  //   ③ 其余维持画像判定（第三方品牌词照旧拦截）
  const trademarkRejections = await countRecentTrademarkRejections(ctx.merchantId);
  const brandOwnDomain = isBrandOwnDomain(ctx.merchantName, ctx.finalUrl);
  const profileTrademarkPolicy: PreflightResult["trademarkPolicy"] =
    ctx.profile.trademark_authorization_status === "authorized" ||
    ctx.profile.trademark_authorization_status === "own_brand"
      ? "free"
      : ctx.profile.trademark_authorization_status === "pending"
        ? "allow_with_authz"
        : "block_brand";
  let trademarkPolicy = profileTrademarkPolicy;
  if (trademarkRejections > 0) {
    trademarkPolicy = "block_brand";
    warnings.push(
      `该商家近 ${REJECTED_HISTORY_DAYS} 天有 ${trademarkRejections} 次商标类拒登记录，本次文案禁用品牌名。`,
    );
  } else if (profileTrademarkPolicy === "block_brand" && brandOwnDomain) {
    trademarkPolicy = "free";
    warnings.push(
      `品牌名「${ctx.merchantName}」与落地页域名一致（品牌自有站），文案允许使用品牌词；若日后出现商标拒登将自动回到严格模式。`,
    );
  }

  if (trademarkPolicy === "block_brand") {
    constraintsParts.push(
      `TRADEMARK: Do NOT use the merchant brand name "${ctx.merchantName}" in any headline / description / sitelink / callout / snippet. Use functional / category language instead. Example: instead of "${ctx.merchantName} Shoes" write "Premium Running Shoes".`,
    );
    blockedKeywords.push(ctx.merchantName);
  } else if (trademarkPolicy === "allow_with_authz") {
    warnings.push(
      `商标授权处理中：本次允许使用品牌名，但建议尽早完成 Google trademark authorization 申请。`,
    );
  }

  // 4) 行业规则
  const industry = ctx.profile.industry_category;
  if (industry && INDUSTRY_RULES[industry]) {
    const rule = INDUSTRY_RULES[industry]!;
    constraintsParts.push(`INDUSTRY RULE (${industry}): ${rule.constraints}`);
    requiredDisclosures.push(...rule.requiredDisclosures);
    blockedKeywords.push(...rule.blockedKeywords);
  }

  // 5) 认证要求
  const certs = ctx.profile.requires_certification ?? {};
  const needsCerts: string[] = [];
  if (certs.healthcare) needsCerts.push("healthcare");
  if (certs.financial) needsCerts.push("financial");
  if (certs.pharmacy) needsCerts.push("pharmacy");
  if (certs.alcohol) needsCerts.push("alcohol");
  if (certs.crypto) needsCerts.push("crypto");
  if (certs.gambling) needsCerts.push("gambling");
  if (needsCerts.length > 0) {
    warnings.push(
      `该商家品类需要 Google Ads 认证：${needsCerts.join(", ")}。如未在 Google Ads 后台申请，将以"受限投放"模式生成（更保守的语气 + 必含披露）。`,
    );
  }

  // 6) 历史拒登 — X8=B 同类型 ≥3 次阻断
  const since = new Date(Date.now() - REJECTED_HISTORY_DAYS * 24 * 60 * 60 * 1000);
  let recentRejectionCount = 0;
  try {
    recentRejectionCount = await prisma.policy_violations.count({
      where: {
        user_merchant_id: ctx.merchantId,
        submitted_at: { gte: since },
      },
    });
  } catch (e) {
    // 表不存在或字段错只警告，不阻断
    console.warn(
      `[PolicyPreflight] policy_violations query failed (merchant=${ctx.merchantId}): ${e instanceof Error ? e.message : e}`,
    );
  }

  if (recentRejectionCount >= REJECTED_THRESHOLD_FOR_BLOCK) {
    blocking.push(
      `该商家近 ${REJECTED_HISTORY_DAYS} 天累计被拒登 ${recentRejectionCount} 次（≥${REJECTED_THRESHOLD_FOR_BLOCK}），按 C-112 X8=B 规则暂时阻断自动生成。请先人工排查拒登原因。`,
    );
  } else if (recentRejectionCount > 0) {
    warnings.push(
      `该商家近 ${REJECTED_HISTORY_DAYS} 天有 ${recentRejectionCount} 次拒登历史，AI 将额外加强政策约束。`,
    );
    constraintsParts.push(
      `HISTORY: This merchant has ${recentRejectionCount} disapproval(s) in the last ${REJECTED_HISTORY_DAYS} days. Apply extra caution to wording.`,
    );
  }

  // 7) 国家限制：中东 / 部分国家对酒精 / 博彩 / 成人 整体禁投
  const country = ctx.targetCountry.toUpperCase();
  const restrictedCountries = ["SA", "AE", "QA", "KW", "BH", "OM", "IR"];
  if (
    restrictedCountries.includes(country) &&
    (industry === "Gambling" || industry === "Mature_Adult")
  ) {
    blocking.push(
      `${country} 严格禁止 ${industry} 品类广告投放。请更换投放国家或下架该商家。`,
    );
  }

  const recommendedTone: PreflightResult["recommendedTone"] =
    industry && INDUSTRY_RULES[industry]
      ? INDUSTRY_RULES[industry]!.tone
      : ctx.profile.compliance_risk_level === "high"
        ? "conservative"
        : "professional";

  const injectedConstraints =
    constraintsParts.length > 0
      ? constraintsParts.join("\n\n")
      : "Standard mainstream e-commerce ad. Follow Google Ads editorial guidelines (no all caps, no '!!', no emojis, no fake urgency, no unverified claims).";

  return {
    approved: blocking.length === 0,
    blocking_reasons: blocking,
    warnings,
    injectedConstraints,
    blockedKeywords: [...new Set(blockedKeywords)],
    requiredDisclosures: [...new Set(requiredDisclosures)],
    recommendedTone,
    trademarkPolicy,
    recentRejectionCount,
  };
}

/**
 * 近 90 天该商家商标类拒登数（policy_name 如 "trademark_in_ad_text"、
 * external_policy_name 如 "Trademarks"；MySQL 默认 CI 排序规则，contains 大小写不敏感）。
 * 查询失败按 0 处理（与主流程 policy_violations 查询同样的容错口径）。
 */
export async function countRecentTrademarkRejections(
  merchantId: bigint,
): Promise<number> {
  const since = new Date(Date.now() - REJECTED_HISTORY_DAYS * 24 * 60 * 60 * 1000);
  try {
    return await prisma.policy_violations.count({
      where: {
        user_merchant_id: merchantId,
        submitted_at: { gte: since },
        OR: [
          { policy_name: { contains: "trademark" } },
          { external_policy_name: { contains: "trademark" } },
        ],
      },
    });
  } catch (e) {
    console.warn(
      `[PolicyPreflight] trademark violations query failed (merchant=${merchantId}): ${e instanceof Error ? e.message : e}`,
    );
    return 0;
  }
}

/**
 * 读取侧（lint 快检 / 提交 H4 / 生成兜底）的品牌词放行推定，与 policyPreflight 第 3 步同源：
 * 品牌词=落地域名（品牌自有站）且近 90 天无商标类拒登 → 允许品牌词。
 * 用于覆盖 crawl_cache.complianceMeta 里生成时写死的 allowBrand=false 旧快照，
 * 让存量草稿不用重新生成即可摆脱 trademark_leak 误报。
 */
export async function shouldAllowBrandByOwnDomain(
  merchantId: bigint | null | undefined,
  merchantName: string,
  finalUrl: string,
): Promise<boolean> {
  if (!isBrandOwnDomain(merchantName, finalUrl)) return false;
  if (merchantId == null) return true;
  return (await countRecentTrademarkRejections(merchantId)) === 0;
}
