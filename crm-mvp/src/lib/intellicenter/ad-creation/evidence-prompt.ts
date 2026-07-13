/**
 * C-112 / D-046.C — Step 6：RAG 证据约束 prompt builder
 *
 * 07 核心需求："文案/信息都要真实"，AI 不能编造。
 *
 * 做法：
 *   1. 从爬虫数据抽 evidence 片段（页面 title / banner / features / 真实产品名+价格 / SemRush 标题）
 *   2. 拼成"证据库"段落注入 prompt
 *   3. 在 prompt 里硬约束 AI："每条 headline/description 必须能在 evidence 中找到支撑，禁止编造数字/折扣/认证/奖项"
 *   4. AI 输出后，由 similarity-scorer.ts 做 cosine 验证（X5=B 阈值 0.7）
 */

import type { MerchantIntelligenceProfile } from "@/lib/intellicenter/merchant-profile/types";
import type { PreflightResult } from "./policy-preflight";
import type { KeywordWithMatchType } from "./keyword-intelligence";
import { sanitizeCrawlText } from "@/lib/crawl-pipeline";

/** D-050 拒登事后学习负样本（单条） */
export interface RejectionLesson {
  /** 中文政策类别名（如「商标侵权」「不可靠声明」） */
  policyLabel: string;
  /** 员工填写的拒登原因（已截断） */
  reason: string;
  /** 被拒时的标题快照（仅同商家强约束携带，给 AI 明确"这些写法已被拒"） */
  headlines?: string[];
}

export interface EvidenceContext {
  /** crawl_pipeline.buildCrawlCache 的 pageText（已截断到 9000 字符即可） */
  pageText?: string;
  /** crawl_pipeline 的 features（如 "Free shipping over $50", "Family-owned since 2012"） */
  features?: string[];
  /** 爬到的真实产品（name + price + currency） */
  crawledProducts?: Array<{ name: string; price?: number; currency?: string }>;
  /** SemRush 拉到的真实 organic title */
  semrushTitles?: string[];
  /** 页面 promotion 信息（discount_percent / discount_amount） */
  promotion?: { discount_percent?: number; discount_amount?: number; currency?: string } | null;
  /**
   * D-050 拒登事后学习负样本：
   *   - sameMerchant：同商家被拒记录 → 强约束（这些写法已被 Google 拒登，绝不能再用）
   *   - sameIndustry：同行业被拒记录 → 软提示（同类商家踩过的坑，尽量规避）
   */
  rejectionFeedback?: {
    sameMerchant: RejectionLesson[];
    sameIndustry: RejectionLesson[];
  } | null;
}

export interface AdGenerationPromptOpts {
  merchantName: string;
  finalUrl: string;
  targetCountry: string;
  languageName: string; // "English (US)" / "German" / "Japanese" 等
  profile: MerchantIntelligenceProfile;
  preflight: PreflightResult;
  keywords: KeywordWithMatchType[];
  evidence: EvidenceContext;
  task: "headline" | "description" | "sitelink" | "callout" | "snippet" | "promotion";
  /** 需要生成的数量 */
  count: number;
  /** 单条最大字符数（headline 30 / description 90 / sitelink_title 25 / callout 25 / snippet header 25） */
  maxLen: number;
  /** 单条最小字符数（description 40，其他 0） */
  minLen?: number;
}

/**
 * 主入口：构造带证据约束的 AI prompt。
 *
 * 输出 prompt 风格：英文（AI 处理英文更稳） + JSON 输出格式 + 硬规则 + 证据库 + 关键词 + 政策约束。
 */
export function buildEvidencePrompt(opts: AdGenerationPromptOpts): string {
  const taskInstructions = TASK_INSTRUCTIONS[opts.task](opts);
  const evidenceBlock = buildEvidenceBlock(opts.merchantName, opts.evidence, opts.preflight.trademarkPolicy === "block_brand");
  const keywordsBlock = buildKeywordsBlock(opts.keywords);
  const profileBlock = buildProfileBlock(opts.profile);
  const policyBlock = buildPolicyBlock(opts.preflight, opts.merchantName);
  const rejectionBlock = buildRejectionBlock(opts.evidence.rejectionFeedback);
  const toneInstruction = TONE_INSTRUCTIONS[opts.preflight.recommendedTone];

  return `You are a senior Google Ads copywriter generating ${opts.task} content for a real merchant.

# Output language
${opts.languageName}

# Output JSON schema (return ONLY this JSON, no markdown fences, no preamble)
${TASK_OUTPUT_SCHEMA[opts.task](opts.count)}

# Task
${taskInstructions}

# Tone
${toneInstruction}

# Merchant profile (concise)
${profileBlock}

# Live evidence (you MUST ground every output line in this evidence — do NOT invent numbers, percentages, certifications, or awards)
${evidenceBlock}

# Approved keywords (each line should target one of these or a close synonym)
${keywordsBlock}

# Policy constraints (MANDATORY — violation will get the ad disapproved by Google)
${policyBlock}
${rejectionBlock ? `\n# Past rejection lessons (CRITICAL — these ads were ALREADY disapproved by Google; you MUST NOT repeat the same claims/wording)\n${rejectionBlock}\n` : ""}
# Hard rules
1. NEVER invent: prices, discount %, awards, certifications, founding year, or testimonials not present in evidence.
2. NEVER use: all-caps words, double exclamation "!!", emojis, "guaranteed", "100%", "#1", "best ever", "miracle".
3. NEVER use the merchant brand name if policy block_brand applies (see Policy constraints above).
4. SUPERLATIVE / AWARD policy (Google Ads "unfair advantage" — read carefully):
   - Bare superlatives are BANNED: do NOT write "Best", "Best Brand", "Top-Rated", "#1", "Award-Winning", "Voted #1", "Awarded", "Awards Won" on their own — Google disapproves unverifiable superiority claims. ("Bestseller"/"Best Sellers" as a retail category word — e.g. "25% Off Bestsellers" — is fine; it states the merchant's own sales fact, not superiority over competitors.)
   - ONLY if the evidence explicitly contains a real, named award/ranking/certification, you MAY cite it in a SPECIFIC, verifiable form that names the issuer and/or year. Example: if evidence shows "2025 Beauty Shortlist Award", write "2025 Beauty Shortlist Winner" (NOT "Best Natural Brand"); if evidence shows "Certified Organic by Demeter", write "Demeter Certified Organic" (NOT "Certified" alone).
   - If you cannot point to a specific named award/cert in the evidence, drop the claim and use a concrete product/benefit fact instead.
5. Length: each output MUST be ≤ ${opts.maxLen} characters${opts.minLen ? ` and ≥ ${opts.minLen} characters` : ""}.
6. Output language: ${opts.languageName} only. Do NOT mix languages.
7. Capitalization: ${opts.task === "description" ? "sentence case (only first word + proper nouns capitalized)" : "Title Case — do NOT capitalize prepositions/articles/conjunctions in the middle"}.
8. Return STRICT JSON. No trailing commas. No explanatory text.`;
}

const TASK_OUTPUT_SCHEMA: Record<
  AdGenerationPromptOpts["task"],
  (count: number) => string
> = {
  headline: (n) => `{"headlines": ["string", ... ${n} items]}`,
  description: (n) => `{"descriptions": ["string", ... ${n} items]}`,
  sitelink: (n) =>
    `{"sitelinks": [{"title": "≤25 chars", "desc1": "≤35 chars", "desc2": "≤35 chars", "url_path": "/path or null"}, ... ${n} items]}`,
  callout: (n) => `{"callouts": ["≤25 chars", ... ${n} items]}`,
  snippet: (n) =>
    `{"snippets": [{"header": "Brands|Models|Services|Styles|Types|Featured hotels|Insurance coverage|Amenities|Courses|Degree programs|Destinations|Service catalog|Shows|Neighborhoods", "values": ["string", ... 4-10 items]}, ... ${n} items]}`,
  promotion: () =>
    `{"promotion": {"item": "string", "promotion_details": "string", "type": "MONETARY_DISCOUNT|PERCENT_DISCOUNT|UP_TO_MONETARY_DISCOUNT|UP_TO_PERCENT_DISCOUNT", "value": number, "currency": "USD|EUR|GBP|JPY|CAD|AUD"}}`,
};

const TASK_INSTRUCTIONS: Record<
  AdGenerationPromptOpts["task"],
  (opts: AdGenerationPromptOpts) => string
> = {
  headline: (opts) =>
    `Write exactly ${opts.count} unique Google Ads RSA headlines, each ≤ ${opts.maxLen} characters. Each headline should target a different angle (benefit / feature / promo / brand / category). No two headlines can share the same opening word.`,
  description: (opts) =>
    `Write exactly ${opts.count} unique Google Ads RSA descriptions, each between ${opts.minLen ?? 40} and ${opts.maxLen} characters. Each must include at least one concrete benefit and one CTA. No two descriptions can share the same opening word.`,
  sitelink: (opts) =>
    `Generate exactly ${opts.count} sitelinks. Each title ≤25 chars, each desc ≤35 chars. Titles should reflect REAL on-site sections (e.g. "Shop New Arrivals", "Sale", "Customer Reviews"). url_path should be a relative path like "/sale" or null.`,
  callout: (opts) =>
    `Generate exactly ${opts.count} callouts, each ≤25 chars. Each callout is a short benefit phrase (e.g. "Free Shipping", "30-Day Returns", "24/7 Support"). No duplicates. No fake claims.`,
  snippet: (opts) =>
    `Generate exactly ${opts.count} structured snippet headers, each with 4-10 values. Pick the most relevant Google-allowed headers from the schema. Values must be real product/service categories visible in evidence.`,
  promotion: () =>
    `Generate ONE promotion extension. Item = the discounted product/category (e.g. "All Footwear"). promotion_details = short hook (e.g. "Free shipping over $50"). Type/value/currency must match an actual promotion visible in evidence — if no real promo, return type=null and item="(no promo)".`,
};

const TONE_INSTRUCTIONS: Record<PreflightResult["recommendedTone"], string> = {
  conservative:
    "Conservative tone. Factual, no superlatives, no urgency. Words to AVOID: best, #1, guaranteed, miracle, instant, now, hurry, limited time. Words to PREFER: trusted, certified, available, professional, supported.",
  professional:
    "Professional tone. Confident but factual. Light promotional words OK (e.g. 'shop', 'discover', 'explore') but no '#1' or '100%'.",
  casual:
    "Casual & friendly tone. Conversational language welcome. Still avoid fake urgency and false claims.",
  energetic:
    "Energetic tone. Action-driven language welcome (e.g. 'discover', 'unlock', 'level up'). Still factual.",
};

function buildEvidenceBlock(merchantName: string, ev: EvidenceContext, blockBrand = false): string {
  const parts: string[] = [];
  if (ev.pageText) {
    // 2026-07-13（第五轮）：prompt 入口净化。新缓存的 pageText 已在爬取侧净化，
    // 但存量旧缓存可能带乱码/代码残片/挑战页文案——脏证据会让 AI 脑补出不存在的
    // 折扣认证，甚至被页面内文字注入指令。乱码率超标时整段弃用（features/SemRush 兜底）。
    const cleanPageText = sanitizeCrawlText(ev.pageText);
    if (cleanPageText.length >= 50) {
      parts.push(
        `## Page text excerpt (truncated)\n${cleanPageText.slice(0, 6000)}`,
      );
    }
  }
  if (ev.features && ev.features.length > 0) {
    parts.push(
      `## Detected page features (verified signals)\n${ev.features.map((f) => `- ${f}`).join("\n")}`,
    );
  }
  if (ev.crawledProducts && ev.crawledProducts.length > 0) {
    parts.push(
      `## Crawled real products (with verified prices)\n${ev.crawledProducts
        .slice(0, 10)
        .map(
          (p, i) =>
            `${i + 1}. ${p.name}${p.price !== undefined ? ` — ${p.currency ?? ""}${p.price}` : ""}`,
        )
        .join("\n")}`,
    );
  }
  if (ev.semrushTitles && ev.semrushTitles.length > 0) {
    // 2026-07-13（第六轮）：block_brand 时 SemRush 标题里的品牌词脱敏为 [brand]。
    // 此前政策块喊「品牌词 BANNED」、证据块却成排注入含品牌词的原标题——AI 面对
    // 互相矛盾的指令时经常照抄证据，商标违规照样出现。
    let titles = ev.semrushTitles.slice(0, 8);
    if (blockBrand && merchantName.trim().length >= 3) {
      const brandRe = new RegExp(merchantName.trim().replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "gi");
      titles = titles.map((t) => t.replace(brandRe, "[brand]"));
    }
    parts.push(
      `## SemRush organic titles (real SEO content)\n${titles
        .map((t) => `- ${t}`)
        .join("\n")}`,
    );
  }
  if (ev.promotion && (ev.promotion.discount_percent || ev.promotion.discount_amount)) {
    parts.push(
      `## Detected promotion\n${
        ev.promotion.discount_percent
          ? `${ev.promotion.discount_percent}% off site-wide`
          : `${ev.promotion.currency ?? "$"}${ev.promotion.discount_amount} off`
      }`,
    );
  }

  if (parts.length === 0) {
    return `(No live evidence — crawl was incomplete. Be especially conservative: generic, factual category language only. Do NOT make up details about ${merchantName}.)`;
  }
  return parts.join("\n\n");
}

function buildKeywordsBlock(keywords: KeywordWithMatchType[]): string {
  if (keywords.length === 0) {
    return "(No keywords provided — use industry-generic category words.)";
  }
  return keywords.map((k) => `- ${k.text} [${k.matchType}, source=${k.source}]`).join("\n");
}

function buildProfileBlock(p: MerchantIntelligenceProfile): string {
  const parts: string[] = [];
  if (p.industry_category) parts.push(`Industry: ${p.industry_category}`);
  if (p.industry_subcategory) parts.push(`Sub-category: ${p.industry_subcategory}`);
  if (p.business_profile?.main_products?.length) {
    parts.push(`Products: ${p.business_profile.main_products.slice(0, 4).join(", ")}`);
  }
  if (p.business_profile?.price_range) parts.push(`Price range: ${p.business_profile.price_range}`);
  if (p.audience_persona?.regions?.length) {
    parts.push(`Audience regions: ${p.audience_persona.regions.join(", ")}`);
  }
  if (p.audience_persona?.age) parts.push(`Audience age: ${p.audience_persona.age}`);
  if (p.brand_assets?.usp?.length) {
    parts.push(`USPs: ${p.brand_assets.usp.slice(0, 3).join(" / ")}`);
  }
  if (parts.length === 0) return "(Profile is sparse — use evidence section instead.)";
  return parts.join("\n");
}

function buildPolicyBlock(pre: PreflightResult, merchantName: string): string {
  const parts: string[] = [];
  parts.push(pre.injectedConstraints);
  if (pre.trademarkPolicy === "block_brand") {
    parts.push(
      `STRICT TRADEMARK: brand name "${merchantName}" is BANNED in every output line. Use category words.`,
    );
  }
  if (pre.requiredDisclosures.length > 0) {
    parts.push(
      `Required disclosures (include at least one if applicable): ${pre.requiredDisclosures.join(" | ")}`,
    );
  }
  if (pre.blockedKeywords.length > 0) {
    parts.push(
      `Banned words (must NOT appear anywhere): ${pre.blockedKeywords.slice(0, 20).join(", ")}`,
    );
  }
  return parts.join("\n\n");
}

/**
 * D-050：把拒登负样本拼成 prompt 块。
 *   - 同商家：强约束（HARD CONSTRAINT），携带被拒文案让 AI 明确避开
 *   - 同行业：软提示（SOFT HINT），仅给政策类别 + 原因，不泄露其他商家文案细节
 */
function buildRejectionBlock(
  fb?: EvidenceContext["rejectionFeedback"],
): string | null {
  if (!fb) return null;
  const parts: string[] = [];
  if (fb.sameMerchant.length > 0) {
    parts.push(
      `## SAME MERCHANT — HARD CONSTRAINT (these exact ads were disapproved; avoid the same wording, claims, and angles)\n` +
        fb.sameMerchant
          .slice(0, 8)
          .map((l, i) => {
            const hl =
              l.headlines && l.headlines.length > 0
                ? ` | rejected copy: ${l.headlines.slice(0, 5).join(" / ")}`
                : "";
            return `${i + 1}. [${l.policyLabel}] ${l.reason}${hl}`;
          })
          .join("\n"),
    );
  }
  if (fb.sameIndustry.length > 0) {
    parts.push(
      `## SAME INDUSTRY — SOFT HINT (similar merchants got rejected for these; steer clear)\n` +
        fb.sameIndustry
          .slice(0, 8)
          .map((l, i) => `${i + 1}. [${l.policyLabel}] ${l.reason}`)
          .join("\n"),
    );
  }
  if (parts.length === 0) return null;
  return parts.join("\n\n");
}
