/**
 * C-112 / D-046.C — Step 3：AI 商家画像自动生成（核心步骤）
 *
 * 07 决策 X2 = [官逆]gpt-5-nano（provider 4 hajimi，与 [官逆]gpt-5-mini 同通道）
 * 07 决策 X7 = 缓存 7 天（profile_updated_at 在 7 天内则跳过 AI 调用，复用缓存）
 *
 * 输入：crawl 数据（pageText 9000 字符 + features 8 条 + crawledProducts 真实价格列表）+ 商家元数据
 * 输出：12 字段画像 JSON，落库到 user_merchants 表（source='ai_backfill', profile_updated_at=NOW()）
 *
 * 设计目标：让画像成为"内部上下文"而非"员工填的表"，整个生成过程对员工透明无感。
 */

import prisma from "@/lib/prisma";
import { callAiWithFallback } from "@/lib/ai-service";
import { extractJsonFromAi } from "@/lib/crawl-pipeline";
import {
  type AudiencePersona,
  type BrandAssets,
  type BusinessProfile,
  COMPLIANCE_RISK_LEVELS,
  type ComplianceRiskLevel,
  type CompetitorBrand,
  DEFAULT_PROFILE,
  INDUSTRY_CATEGORIES,
  INDUSTRY_LABELS_CN,
  type IndustryCategory,
  type MerchantIntelligenceProfile,
  type RequiresCertification,
  type SeasonalPattern,
  TRADEMARK_AUTH_STATUSES,
  type TrademarkAuthStatus,
} from "@/lib/intellicenter/merchant-profile/types";
import {
  loadMerchantProfile,
  saveMerchantProfile,
} from "@/lib/intellicenter/merchant-profile/reader";

const AI_SCENE = "ad_creation_intelligent"; // C-112 新建专用 scene，priority=1 gpt-5-nano
const MAX_PAGE_TEXT_CHARS = 9000;
const MAX_FEATURES = 8;
const MAX_PRODUCTS_FOR_PROMPT = 12;
const PROFILE_CACHE_DAYS = 7; // X7=B 缓存 7 天

export interface ProfileGenerationContext {
  merchantId: bigint;
  merchantName: string;
  merchantUrl: string;
  category?: string | null;
  targetCountry: string;
  /** Step 2 爬虫输出（来自 crawl-pipeline.buildCrawlCache 的 CrawlCache 子集） */
  crawl?: {
    pageText?: string;
    features?: string[];
    crawledProducts?: Array<{ name: string; price?: number; currency?: string }>;
    semrushTitles?: string[];
    detectedLanguageCode?: string;
  } | null;
  /** 强制重生（即使缓存未过期），默认 false */
  forceRefresh?: boolean;
}

export interface ProfileGenerationResult {
  profile: MerchantIntelligenceProfile;
  /** 命中缓存（profile_updated_at 在 PROFILE_CACHE_DAYS 内） */
  cacheHit: boolean;
  /** AI 实际调用次数（0=纯缓存命中 / 1=单次成功 / 2=单次重试） */
  aiCalls: number;
  /** 总耗时 ms */
  elapsedMs: number;
  /** 失败时填，仍返回 DEFAULT_PROFILE 让上游降级 */
  error?: string;
}

/**
 * 主入口：按需生成商家画像。
 *
 * 流程：
 *   1. loadMerchantProfile 检查缓存（profile_updated_at < 7 天 && profile_source 不是 'ai_failed'）→ 命中直接返回
 *   2. 缓存过期/缺失 → 拼 prompt 调 gpt-5-nano（fallback 链 mini → claude-sonnet-4-6）
 *   3. JSON 解析 + 类型校验 + 写库（source='ai_backfill', profile_updated_at=NOW()）
 *   4. AI 失败 2 次 → 落 'ai_failed' source + 返回 DEFAULT_PROFILE 让上游降级（不阻断广告创建）
 */
export async function generateMerchantProfile(
  ctx: ProfileGenerationContext,
): Promise<ProfileGenerationResult> {
  const startedAt = Date.now();

  if (!ctx.forceRefresh) {
    const cached = await loadMerchantProfile(ctx.merchantId);
    if (isProfileFresh(cached)) {
      return {
        profile: cached,
        cacheHit: true,
        aiCalls: 0,
        elapsedMs: Date.now() - startedAt,
      };
    }
  }

  const prompt = buildProfileGenerationPrompt(ctx);

  let aiCalls = 0;
  let lastError: string | undefined;
  for (let attempt = 0; attempt < 2; attempt++) {
    aiCalls += 1;
    try {
      const raw = await callAiWithFallback(
        AI_SCENE,
        [
          {
            role: "system",
            content:
              "You are an expert e-commerce business analyst for Google Ads compliance. " +
              "Return ONLY valid JSON matching the requested schema. No prose. No markdown fences. " +
              "When uncertain, prefer conservative values (low risk_level, unauthorized trademark) over fabrication.",
          },
          { role: "user", content: prompt },
        ],
        2048,
      );
      const parsed = parseAiProfileResponse(raw);
      if (!parsed) {
        lastError = "AI response did not parse to valid profile JSON";
        continue;
      }
      const saved = await saveMerchantProfile({
        merchantId: ctx.merchantId,
        payload: parsed,
        source: "ai_backfill",
      });
      return {
        profile: saved,
        cacheHit: false,
        aiCalls,
        elapsedMs: Date.now() - startedAt,
      };
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err);
      console.warn(
        `[ProfileGenerator] merchant=${ctx.merchantId} attempt=${attempt + 1} failed: ${lastError}`,
      );
    }
  }

  // 两次 AI 全失败 → 标记 ai_failed + 返回默认画像让上游降级
  try {
    await prisma.user_merchants.update({
      where: { id: ctx.merchantId },
      data: {
        profile_source: "ai_failed",
        profile_updated_at: new Date(),
      } as never,
    });
  } catch (e) {
    console.warn(
      `[ProfileGenerator] mark ai_failed flag failed for merchant=${ctx.merchantId}: ${e instanceof Error ? e.message : e}`,
    );
  }

  return {
    profile: { ...DEFAULT_PROFILE },
    cacheHit: false,
    aiCalls,
    elapsedMs: Date.now() - startedAt,
    error: lastError ?? "AI generation failed",
  };
}

/**
 * 判断画像是否 fresh：
 *   - profile_source 必须是 ai_backfill / manual / feedback（不接受 none / ai_failed）
 *   - industry_category 必须非空（防止旧空记录被当作缓存）
 *   - profile_updated_at 必须在 PROFILE_CACHE_DAYS 天内
 */
function isProfileFresh(p: MerchantIntelligenceProfile): boolean {
  if (!p.industry_category) return false;
  if (p.profile_source === "none" || p.profile_source === "ai_failed") return false;
  if (!p.profile_updated_at) return false;
  const ageMs = Date.now() - p.profile_updated_at.getTime();
  return ageMs < PROFILE_CACHE_DAYS * 24 * 60 * 60 * 1000;
}

/**
 * 构造 AI 输入 prompt。
 *
 * 强约束：
 *   - 输出严格 JSON，无 markdown 围栏
 *   - industry_category 必须是 32 枚举之一
 *   - trademark_authorization_status 默认 unauthorized（除非 page 明确显示官方店）
 *   - compliance_risk_level 按 Google Ads 政策保守评估
 *   - 所有 JSON 字段缺失时填 null（不要瞎编）
 */
function buildProfileGenerationPrompt(ctx: ProfileGenerationContext): string {
  const pageText = (ctx.crawl?.pageText ?? "").slice(0, MAX_PAGE_TEXT_CHARS);
  const features = (ctx.crawl?.features ?? []).slice(0, MAX_FEATURES);
  const products = (ctx.crawl?.crawledProducts ?? []).slice(0, MAX_PRODUCTS_FOR_PROMPT);
  const semrushTitles = (ctx.crawl?.semrushTitles ?? []).slice(0, 8);
  const pageLang = ctx.crawl?.detectedLanguageCode ?? "unknown";

  const productsBlock =
    products.length > 0
      ? products
          .map(
            (p, i) =>
              `${i + 1}. ${p.name}${p.price !== undefined ? ` (${p.currency ?? ""}${p.price})` : ""}`,
          )
          .join("\n")
      : "(no products extracted)";

  return `Analyze the following merchant and produce a structured intelligence profile for Google Ads automation.

# Merchant facts
- name: ${ctx.merchantName}
- url: ${ctx.merchantUrl}
- platform_category: ${ctx.category ?? "(unknown)"}
- target_country: ${ctx.targetCountry}
- page_language_detected: ${pageLang}

# Real signals from live crawl (use these to derive everything, DO NOT invent)
## Page text (truncated to ${MAX_PAGE_TEXT_CHARS} chars)
${pageText || "(no page text — crawl failed or SPA)"}

## Detected page features
${features.length > 0 ? features.map((f) => `- ${f}`).join("\n") : "(none)"}

## Crawled products (real prices)
${productsBlock}

## SemRush organic titles (top 8 if available)
${semrushTitles.length > 0 ? semrushTitles.map((t) => `- ${t}`).join("\n") : "(none)"}

# Task
Return ONLY a single JSON object (no markdown fences, no preamble) with these fields:

{
  "industry_category": "<ONE of: ${INDUSTRY_CATEGORIES.join(" | ")}>",
  "industry_subcategory": "<concrete sub-category in 1-4 English words, e.g. 'Wireless Earbuds' / 'RV Rentals' / null if unsure>",
  "business_profile": {
    "main_products": ["<top 3-6 product types in English>"],
    "price_range": "<e.g. '$29-$199' or 'low-cost' or null>",
    "discount_mode": "<e.g. 'site-wide sale 30%' or 'occasional promo' or 'no discount' or null>",
    "shipping": "<e.g. 'free over $50' or null>",
    "payment": "<e.g. 'card+paypal' or null>",
    "notes": "<one-sentence English summary of how this merchant makes money, ≤120 chars>"
  },
  "audience_persona": {
    "age": "<e.g. '25-45'>",
    "gender": "<'all' | 'female-leaning' | 'male-leaning' | null>",
    "regions": ["<ISO country codes top 3>"],
    "interests": ["<top 3 interest tags>"],
    "purchasing_power": "<'budget' | 'mid' | 'premium' | null>"
  },
  "brand_assets": {
    "slogan": "<exact slogan if found on page, else null>",
    "usp": ["<top 3 unique selling points, each ≤8 words>"],
    "certifications": ["<e.g. 'FDA' / 'CE' / 'ISO9001' if found on page, else []>"],
    "awards": [],
    "endorsements": [],
    "reputation_score": null
  },
  "trademark_authorization_status": "<ONE of: ${TRADEMARK_AUTH_STATUSES.join(" | ")}>",
  "compliance_risk_level": "<ONE of: ${COMPLIANCE_RISK_LEVELS.join(" | ")}>",
  "requires_certification": {
    "healthcare": <true if sells supplements/drugs/medical devices, else false>,
    "financial": <true if loans/credit/investment, else false>,
    "crypto": <true if crypto/blockchain, else false>,
    "alcohol": <true if alcohol, else false>,
    "pharmacy": <true if pharmacy/Rx, else false>,
    "political": false,
    "gambling": <true if gambling/casino/betting, else false>,
    "legal": <true if legal services, else false>
  },
  "seasonal_pattern": {
    "peak_months": [<1-12 integers, e.g. [11,12]>],
    "holiday_events": ["<e.g. 'BlackFriday', 'Christmas', 'BackToSchool'>"],
    "promo_calendar": []
  },
  "competitor_brands": [{ "name": "<competitor brand seen on page or known in industry>", "domain": "<their domain if known else null>" }]
}

# Hard rules
1. industry_category MUST be one of the 32 enums; if uncertain pick the closest fit, never invent.
2. trademark_authorization_status defaults to "unauthorized" UNLESS the page clearly shows this is the brand's own official site (e.g. URL matches brand name + page footer says "© ${ctx.merchantName} Official"). If clearly own brand → "own_brand".
3. compliance_risk_level scale:
   - "blocked" = sells obviously prohibited goods (counterfeit, weapons, illicit drugs)
   - "high"   = healthcare / financial / crypto / gambling / alcohol / adult / loans
   - "medium" = legal / dating / political / restricted categories
   - "low"    = mainstream e-commerce (apparel, electronics, home, beauty, food)
4. If a field genuinely cannot be derived from crawl signals, return null (NEVER fabricate numbers / awards / certifications).
5. Output MUST be a single valid JSON object. No trailing commas. No comments.

Industry category Chinese reference (for your understanding only, output values must be the English enum):
${INDUSTRY_CATEGORIES.map((c) => `${c} = ${INDUSTRY_LABELS_CN[c]}`).join(" | ")}
`;
}

/**
 * 解析 AI 返回的 JSON 并强类型校验。
 *
 * 拒绝原则：
 *   - JSON 解析失败 → null
 *   - 缺失 industry_category 或非 32 枚举 → null（强制重试）
 *   - 其他字段缺失/类型错 → 用 DEFAULT 填充，不阻断
 */
function parseAiProfileResponse(raw: string): {
  industry_category: IndustryCategory;
  industry_subcategory: string | null;
  business_profile: BusinessProfile | null;
  audience_persona: AudiencePersona | null;
  brand_assets: BrandAssets | null;
  trademark_authorization_status: TrademarkAuthStatus;
  compliance_risk_level: ComplianceRiskLevel;
  requires_certification: RequiresCertification | null;
  seasonal_pattern: SeasonalPattern | null;
  competitor_brands: CompetitorBrand[] | null;
} | null {
  let data: Record<string, unknown>;
  try {
    const jsonText = extractJsonFromAi(raw);
    data = JSON.parse(jsonText) as Record<string, unknown>;
  } catch {
    return null;
  }

  const industry = data.industry_category;
  if (
    typeof industry !== "string" ||
    !(INDUSTRY_CATEGORIES as readonly string[]).includes(industry)
  ) {
    return null; // 强制重试 — industry_category 是核心字段
  }

  const trademark =
    typeof data.trademark_authorization_status === "string" &&
    (TRADEMARK_AUTH_STATUSES as readonly string[]).includes(
      data.trademark_authorization_status,
    )
      ? (data.trademark_authorization_status as TrademarkAuthStatus)
      : "unauthorized";

  const risk =
    typeof data.compliance_risk_level === "string" &&
    (COMPLIANCE_RISK_LEVELS as readonly string[]).includes(
      data.compliance_risk_level,
    )
      ? (data.compliance_risk_level as ComplianceRiskLevel)
      : "low";

  const stringOrNull = (v: unknown): string | null =>
    typeof v === "string" && v.trim() ? v.trim() : null;
  const objectOrNull = <T>(v: unknown): T | null =>
    v && typeof v === "object" && !Array.isArray(v) ? (v as T) : null;
  const arrayOrNull = <T>(v: unknown): T[] | null =>
    Array.isArray(v) && v.length > 0 ? (v as T[]) : null;

  const competitors = arrayOrNull<unknown>(data.competitor_brands);
  const sanitizedCompetitors: CompetitorBrand[] | null = competitors
    ? (competitors
        .map((c) => {
          if (!c || typeof c !== "object") return null;
          const item = c as Record<string, unknown>;
          const name = stringOrNull(item.name);
          if (!name) return null;
          const domain = stringOrNull(item.domain);
          const result: CompetitorBrand = domain ? { name, domain } : { name };
          return result;
        })
        .filter((c): c is CompetitorBrand => c !== null))
    : null;

  return {
    industry_category: industry as IndustryCategory,
    industry_subcategory: stringOrNull(data.industry_subcategory),
    business_profile: objectOrNull<BusinessProfile>(data.business_profile),
    audience_persona: objectOrNull<AudiencePersona>(data.audience_persona),
    brand_assets: objectOrNull<BrandAssets>(data.brand_assets),
    trademark_authorization_status: trademark,
    compliance_risk_level: risk,
    requires_certification: objectOrNull<RequiresCertification>(
      data.requires_certification,
    ),
    seasonal_pattern: objectOrNull<SeasonalPattern>(data.seasonal_pattern),
    competitor_brands:
      sanitizedCompetitors && sanitizedCompetitors.length > 0
        ? sanitizedCompetitors
        : null,
  };
}
