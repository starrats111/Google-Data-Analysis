import { NextRequest } from "next/server";
import { getUserFromRequest, serializeData } from "@/lib/auth";
import { apiError } from "@/lib/constants";
import prisma from "@/lib/prisma";
import { callAiWithFallback, suggestDisplayPaths } from "@/lib/ai-service";
import { getAdMarketConfig, resolveLanguageName } from "@/lib/ad-market";
import { buildAiRulePrompt, checkItemViolations, resolveForbiddenTerms, autoRewriteForbiddenTerms } from "@/lib/ai-rule-profile";
import { isLowValueSitelink } from "@/lib/sitelink-filter";
import { acquireGenerationSlot } from "@/lib/generation-gate";
import {
  type CrawlCache,
  buildCrawlCache,
  extractMerchantFeatures,
  extractPromotionInfo,
  extractPriceInfo,
  extractJsonFromAi,
  smartTruncate,
  titleFromUrlPath,
  decodeHtmlEntities,
  sanitizeAdText,
  isBadSitelinkUrl,
} from "@/lib/crawl-pipeline";
import { buildCrawlKey, withCrawlInflightLock } from "@/lib/crawl-inflight-lock";
import { fetchSemrushKeywords, type SemrushKeywordsResult } from "@/lib/semrush-keywords";
import { matchParkedTextSignal } from "@/lib/country-url-resolver";
import { humanizeAdCopyBatch, AD_COPY_ANTI_AI_BLOCK } from "@/lib/humanizer";
import { autoExpandSitelinks } from "@/lib/sitelink-auto-expand";
import { generateSitelinkTexts } from "@/lib/sitelink-ai-writer";
// C-112 / D-046.C — AI 广告创建 8 步智能闭环
import {
  runIntelligentAdCreation,
  checkReachability,
  isHardUnreachable,
  type KeywordCandidate,
  type OrchestratorTask,
} from "@/lib/intellicenter/ad-creation";

function formatAiRuleBlock(profile: unknown | null | undefined, section: "sitelinks" | "ad_copy" | "compliance"): string {
  if (!profile) return "";
  const text = buildAiRulePrompt(profile, section);
  return text ? `\nUser hard rules (MUST follow):\n${text}\n` : "";
}

/**
 * AI 语义缩略：将超过 maxLen 的文案用 AI 缩写，保留核心含义和商业意图
 * 一次调用批量处理所有超长项，失败时降级为 smartTruncate
 */
async function condenseOverlong(items: string[], maxLen: number, languageName: string): Promise<string[]> {
  const overlong = items
    .map((text, idx) => ({ idx, text }))
    .filter((item) => item.text.length > maxLen);
  if (overlong.length === 0) return items;

  // 单条 AI 精简（用于批量失败后的逐条重试）
  // 失败时返回空字符串，由下游 retryMissingHeadlines 补一条语义完整的新标题
  const condenseSingle = async (text: string): Promise<string> => {
    const rewritePrompt = `Rewrite this Google Ads text into a semantically complete phrase within ${maxLen} characters. Keep the core meaning. Write in ${languageName}.\n\nOriginal (${text.length} chars): "${text}"\n\nOutput ONLY the rewritten text. It MUST be ≤${maxLen} characters and must be a complete, meaningful phrase — do NOT truncate mid-word or mid-idea.`;
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const raw = await callAiWithFallback("ad_copy", [{ role: "user", content: rewritePrompt }], 120);
        const result = raw.trim().replace(/^["']|["']$/g, "");
        if (result.length >= 2 && result.length <= maxLen) return result;
      } catch {}
    }
    // 两次返工均失败：返回空字符串，由 retryMissingHeadlines 补一条全新的完整文案
    console.warn(`[condenseOverlong] "${text.slice(0, 30)}..." 无法压缩至 ${maxLen} 字符，丢弃并由返工流程补充`);
    return "";
  };

  try {
    const condensedPrompt = `Condense each line to ≤${maxLen} characters. Keep the same language (${languageName}). Preserve brand names, numbers, and key selling points. Do NOT add new information.

${overlong.map((item, i) => `${i + 1}. "${item.text}" (${item.text.length} chars → must be ≤${maxLen})`).join("\n")}

Return ONLY a JSON array of condensed strings in the same order. Every string MUST be ≤${maxLen} characters.`;
    const rawResult = await callAiWithFallback("ad_copy", [{ role: "user", content: condensedPrompt }], 1024);
    const condensed = JSON.parse(extractJsonFromAi(rawResult));
    if (!Array.isArray(condensed) || condensed.length !== overlong.length) throw new Error("AI 返回数量不匹配");

    const result = [...items];
    for (let i = 0; i < overlong.length; i++) {
      const c = String(condensed[i] || "").trim();
      if (c.length >= 2 && c.length <= maxLen) {
        result[overlong[i].idx] = c;
      } else {
        // 批量精简后仍超长，逐条再精简一次
        result[overlong[i].idx] = await condenseSingle(overlong[i].text);
      }
    }
    console.log(`[condenseOverlong] AI 缩略 ${overlong.length} 条超长文案 (maxLen=${maxLen})`);
    return result;
  } catch (err) {
    console.warn("[condenseOverlong] 批量 AI 缩略失败，逐条重试:", err instanceof Error ? err.message : err);
    const result = [...items];
    for (const item of overlong) {
      result[item.idx] = await condenseSingle(item.text);
    }
    return result;
  }
}

/**
 * AI 返工补全：当已有标题不足 count 条时，明确告知 AI 还差几条，让它重新生成。
 * 最多重试 maxRetries 次，仍不足时以现有数量返回（不用静态 fallback）。
 */
async function retryMissingHeadlines(
  existing: string[],
  count: number,
  merchantName: string,
  languageName: string,
  maxRetries = 2,
): Promise<string[]> {
  let result = [...existing];
  for (let attempt = 0; attempt < maxRetries && result.length < count; attempt++) {
    const needed = count - result.length;
    const existingList = result.map((h, i) => `${i + 1}. "${h}"`).join("\n");
    const prompt = `You are writing Google Ads headlines for a merchant that sells: ${merchantName}.

You must generate exactly ${needed} NEW headlines in ${languageName}.

STRICT RULES:
1. Each headline MUST be ≤ 30 characters (count EVERY character including spaces and punctuation)
2. Write ONLY in ${languageName}
3. Do NOT duplicate or rephrase any of these existing headlines:
${existingList}
4. No dates, no fabricated discount numbers
5. Each headline must start with a DIFFERENT word
6. TRADEMARK: Do NOT use the brand name "${merchantName}" or any founder/designer personal name in any headline. Use functional/category language instead.
7. CAPITALIZATION: Use standard Title Case — do NOT capitalize prepositions (of, in, for, to, at, by, with, on, from, as), articles (a, an, the), or conjunctions (and, but, or, nor, so, yet) in the MIDDLE of a headline. Never use ALL CAPS words.
   ✗ "End Of Play Sneakers" → ✓ "End-of-Play Sneakers"
   ✗ "Shop For The Best Deals" → ✓ "Shop for the Best Deals"

Return ONLY a JSON array of exactly ${needed} strings. Example: ["Headline one","Headline two"]`;

    try {
      const raw = await callAiWithFallback("ad_copy", [{ role: "user", content: prompt }], 1024);
      const parsed = JSON.parse(extractJsonFromAi(raw)) as string[];
      if (!Array.isArray(parsed)) continue;
      const condensed = await condenseOverlong(parsed, 30, languageName);
      const valid = condensed
        .map((h) => h.trim().replace(/^["']|["']$/g, ""))
        .filter((h) => h.length >= 2 && h.length <= 30 && !result.includes(h));
      result = [...result, ...valid].slice(0, count);
      console.log(`[retryHeadlines] 第${attempt + 1}次补充 +${valid.length} 条，当前共 ${result.length}/${count}`);
    } catch (e) {
      console.warn(`[retryHeadlines] 第${attempt + 1}次补充失败:`, e instanceof Error ? e.message : e);
    }
  }
  return result;
}

/**
 * AI 返工补全：描述不足 count 条时，明确告知 AI 还差几条，让它重新生成。
 */
async function retryMissingDescriptions(
  existing: string[],
  count: number,
  merchantName: string,
  languageName: string,
  maxRetries = 2,
): Promise<string[]> {
  let result = [...existing];
  for (let attempt = 0; attempt < maxRetries && result.length < count; attempt++) {
    const needed = count - result.length;
    const existingList = result.map((d, i) => `${i + 1}. "${d}"`).join("\n");
    const prompt = `You are writing Google Ads descriptions for a merchant that sells: ${merchantName}.

Generate exactly ${needed} NEW descriptions in ${languageName}.

STRICT RULES:
1. Each description MUST be between 40 and 90 characters (count EVERY character including spaces)
2. Write ONLY in ${languageName}
3. Do NOT duplicate or closely rephrase any of these existing descriptions:
${existingList}
4. No fabricated discounts or unverified claims
5. Each description must open with a DIFFERENT word
6. TRADEMARK: Do NOT use the brand name "${merchantName}" or any founder/designer personal name in any description. Use functional/benefit language instead.
7. CAPITALIZATION: Descriptions must use sentence case — only capitalize the first word and proper nouns. Never use ALL CAPS words.

Return ONLY a JSON array of exactly ${needed} strings.`;

    try {
      const raw = await callAiWithFallback("ad_copy", [{ role: "user", content: prompt }], 1024);
      const parsed = JSON.parse(extractJsonFromAi(raw)) as string[];
      if (!Array.isArray(parsed)) continue;
      const condensed = await condenseOverlong(parsed, 90, languageName);
      const valid = condensed
        .map((d) => d.trim().replace(/^["']|["']$/g, ""))
        .filter((d) => d.length >= 40 && d.length <= 90 && !result.includes(d));
      result = [...result, ...valid].slice(0, count);
      console.log(`[retryDescriptions] 第${attempt + 1}次补充 +${valid.length} 条，当前共 ${result.length}/${count}`);
    } catch (e) {
      console.warn(`[retryDescriptions] 第${attempt + 1}次补充失败:`, e instanceof Error ? e.message : e);
    }
  }
  return result;
}

/**
 * C-082 Part D (RC-4)：主题一致性后置校验。
 * 防御 AI 即使有 pageText/keywords/category 也被品牌名 prior 拉偏到错误品类（Yoin BE → 服装事故）。
 *
 * 用便宜 AI 调用判断 headlines 描述的语义品类是否与商家真实业务一致。
 *   aligned=true   → 一致，不做任何动作
 *   aligned=false  → 配合 expected_category 触发按品类重写 retry
 *
 * 失败保守处理（假设对齐），避免误判把正确 headlines 重写错。
 */
type AlignmentVerdict = {
  aligned: boolean;
  expectedCategory: string;
  detectedCategory: string;
  driftReason: string;
};

async function verifyHeadlinesAlignment(
  headlines: string[],
  pageText: string,
  category: string | null,
  keywords: string[],
  businessSummary: { summary_en?: string; category_guess?: string; source?: string } | null,
  _merchantName: string,
): Promise<AlignmentVerdict> {
  if (headlines.length === 0) {
    return { aligned: true, expectedCategory: "", detectedCategory: "", driftReason: "no headlines" };
  }
  const sample = headlines.slice(0, 8);
  const summaryHint = businessSummary?.summary_en
    ? `Business summary (source=${businessSummary.source || "ai"}): ${businessSummary.summary_en}\n${businessSummary.category_guess ? `Business model: ${businessSummary.category_guess}\n` : ""}`
    : "";
  const keywordsHint = keywords.length > 0 ? `Confirmed keywords: ${keywords.slice(0, 10).join(", ")}\n` : "";
  const categoryHint = category ? `Affiliate-platform category tag: ${category}\n` : "";

  const prompt = `You are a topic-alignment auditor for Google Ads.

The merchant's TRUE business comes from these signals (priority: summary > keywords > website excerpt > affiliate tag):
${summaryHint}${keywordsHint}${categoryHint}
Real website content excerpt (first 500 chars):
${(pageText || "").slice(0, 500)}

The generated headlines are:
${sample.map((h, i) => `${i + 1}. "${h}"`).join("\n")}

Task: Determine if the SEMANTIC THEME of the headlines matches what the merchant actually sells.
- "Matched"  = headlines describe the merchant's real product/service category
- "Drifted"  = headlines describe a completely different product category (e.g. headlines talk about clothing but the merchant sells mobile phone plans)

Return ONLY a JSON object:
{
  "aligned": true | false,
  "expected_category": "<5-15 word description of what the merchant ACTUALLY sells, grounded in the signals above>",
  "detected_category": "<5-15 word description of what the headlines DESCRIBE>",
  "drift_reason": "<short reason if aligned=false, empty string if aligned=true>"
}

Rules:
1. Set aligned=true ONLY if the headlines clearly describe the merchant's real business
2. Be STRICT — minor stylistic difference is OK, but cross-category drift (e.g. clothing vs telecom) is NOT OK
3. expected_category MUST be grounded in the signals (never invented from the brand name)
4. Output VALID JSON only, no extra text`;

  try {
    const raw = await callAiWithFallback("ad_copy", [{ role: "user", content: prompt }], 320);
    const parsed = JSON.parse(extractJsonFromAi(raw)) as Record<string, unknown>;
    return {
      aligned: parsed.aligned === true,
      expectedCategory: String(parsed.expected_category || "").slice(0, 200),
      detectedCategory: String(parsed.detected_category || "").slice(0, 200),
      driftReason: String(parsed.drift_reason || "").slice(0, 300),
    };
  } catch (err) {
    console.warn("[Core] 主题对齐校验 AI 失败，保守假设对齐:", err instanceof Error ? err.message : err);
    return { aligned: true, expectedCategory: "", detectedCategory: "", driftReason: "verify failed" };
  }
}

/**
 * C-082 Part D (RC-4)：按真实品类强制重写 15 条 headlines，绝对不写错误品类的词。
 * 仅在 verifyHeadlinesAlignment 报告 aligned=false 时调用，最多调一次。
 */
async function rewriteHeadlinesForCategory(
  originalHeadlines: string[],
  expectedCategory: string,
  wrongDirection: string,
  merchantName: string,
  pageText: string,
  keywords: string[],
  languageName: string,
  count = 15,
): Promise<string[]> {
  const keywordBlock = keywords.length > 0
    ? `\nTarget keywords (write at least 4 headlines that include or mirror these):\n${keywords.slice(0, 10).map((k, i) => `${i + 1}. ${k}`).join("\n")}\n`
    : "";
  const prompt = `URGENT CATEGORY REWRITE — the previous headlines completely missed what this merchant actually sells.

The merchant is a ${expectedCategory}, NOT a ${wrongDirection || "different category"}.

Merchant: ${merchantName}
Real website content (use ONLY this to infer angles):
${(pageText || "").slice(0, 2000)}
${keywordBlock}
REJECTED PREVIOUS HEADLINES (do NOT repeat or borrow vocabulary from these):
${originalHeadlines.slice(0, 15).map((h, i) => `${i + 1}. "${h}"`).join("\n")}

RULES:
1. Write EXACTLY ${count} headlines in ${languageName}
2. Each headline ≤ 30 characters (count every character)
3. EVERY single headline MUST be about ${expectedCategory} (the merchant's real business)
4. Headline #1 MUST include "${merchantName}"
5. ZERO words from the "${wrongDirection || "wrong"}" semantic field
6. Each headline must start with a DIFFERENT word
7. No fabricated discounts or dates
8. Vary syntax: questions, statements, commands, noun phrases

Return ONLY a JSON array of exactly ${count} strings.`;

  try {
    const raw = await callAiWithFallback("ad_copy", [{ role: "user", content: prompt }], 2048);
    const parsed = JSON.parse(extractJsonFromAi(raw));
    if (!Array.isArray(parsed)) return originalHeadlines;
    const valid = parsed
      .map((h) => String(h || "").trim().replace(/^["']|["']$/g, ""))
      .filter((h) => h.length >= 2 && h.length <= 30);
    if (valid.length >= count - 2) return valid.slice(0, count);
    return originalHeadlines;
  } catch (err) {
    console.warn("[Core] 按品类重写失败，保留原 headlines:", err instanceof Error ? err.message : err);
    return originalHeadlines;
  }
}

const MAX_COMPLIANCE_RETRIES = 3;

async function complianceAutoFix(
  items: string[],
  type: "headline" | "description",
  merchantName: string,
  languageName: string,
  aiRuleProfile: unknown,
  maxLen: number,
  minLen: number,
): Promise<{ items: string[]; fixed: string[]; remaining: string[] }> {
  let current = [...items];
  const allFixed: string[] = [];

  for (let attempt = 0; attempt < MAX_COMPLIANCE_RETRIES; attempt++) {
    const violations = checkItemViolations(current, aiRuleProfile);
    if (violations.length === 0) return { items: current, fixed: allFixed, remaining: [] };

    const label = type === "headline" ? "标题" : "描述";
    console.log(`[complianceAutoFix] ${label}第${attempt + 1}次修复: ${violations.length} 条违规`);

    const avoidReasons = [...new Set(violations.flatMap((v) => v.reasons))];
    const violatingTexts = violations.map((v) => v.text.toLowerCase());

    const prompt = `Generate ${violations.length} replacement Google Ads RSA ${type === "headline" ? "headlines" : "descriptions"}.
Merchant: ${merchantName}, Language: ${languageName}

The following were REJECTED for policy violations and need replacements:
${violations.map((v, i) => `${i + 1}. "${v.text}" — reason: ${v.reasons.join(", ")}`).join("\n")}

CRITICAL AVOIDANCE RULES — your output will be auto-checked, violations cause rejection:
${avoidReasons.map((r) => `- MUST NOT trigger: ${r}`).join("\n")}
- Never use these exact words: guaranteed, risk-free, zero risk, 100% safe, cure, cures, miracle, heal, heals, instant approval, before and after
- Use factual, benefit-driven language instead of absolute promises or medical claims
- Each ${type === "headline" ? "headline" : "description"}: ${minLen}-${maxLen} characters
- IMPORTANT: Write COMPLETELY DIFFERENT content from the rejected items, do not just rephrase them
Return ONLY a JSON array of ${violations.length} strings.`;

    try {
      const raw = await callAiWithFallback("ad_copy", [{ role: "user", content: prompt }], 1024);
      const parsed = JSON.parse(extractJsonFromAi(raw));
      if (Array.isArray(parsed)) {
        for (let i = 0; i < violations.length && i < parsed.length; i++) {
          const replacement = String(parsed[i] || "").trim();
          if (replacement.length >= minLen && replacement.length <= maxLen) {
            allFixed.push(`「${violations[i].text}」→「${replacement}」`);
            current[violations[i].index] = replacement;
          }
        }
      }
    } catch (err) {
      console.warn(`[complianceAutoFix] ${label}第${attempt + 1}次重生成失败:`, err instanceof Error ? err.message : err);
      break;
    }
  }

  // 最终检查：仍然违规的直接删除，不保留
  const finalViolations = checkItemViolations(current, aiRuleProfile);
  const remaining: string[] = [];
  if (finalViolations.length > 0) {
    const label = type === "headline" ? "标题" : "描述";
    const removeIndices = new Set(finalViolations.map((v) => v.index));
    for (const v of finalViolations) {
      remaining.push(`${label}「${v.text}」已删除（${v.reasons.join("、")}）`);
    }
    current = current.filter((_, idx) => !removeIndices.has(idx));
    console.log(`[complianceAutoFix] ${label}最终删除 ${finalViolations.length} 条无法修复的违规项`);
  }

  return { items: current, fixed: allFixed, remaining };
}

/**
 * POST /api/user/ad-creation/generate-extensions
 *
 * types 支持:
 *   "core"    → 1 次 AI 生成标题(15) + 描述(4) + 站内链接描述 + 图片筛选
 *   "optional" + optionalTypes: ["callouts","promotion","price","call","snippet"]
 *              → 1 次 AI 批量生成所有勾选的可选扩展
 *
 * 数据来自 ad_creatives.crawl_cache（认领时已缓存），缺失时现场爬取
 */
// ───────────────────────────────────────────────────────────────
// D-090：广告生成上下文加载 + 流水线构造（SSE 旧链路与后台 job runner 共用）
// 把原 POST 里"加载 campaign/merchant/cache + 构造 SSE 流"两段抽成可复用函数：
//   - loadGenContext：按 campaign_id 装配生成所需全部上下文
//   - buildGenerationStream：构造与原先逐字节一致的 SSE ReadableStream
// 旧 POST（本文件底部）继续返回该流（灰度回滚 fallback）；后台 runner 则消费同一条流落库。
// ───────────────────────────────────────────────────────────────

export interface GenerationRequestPayload {
  types: string[];
  ad_language?: string | null;
  keywords?: string[];
  optionalTypes?: string[];
}

type GenCampaign = NonNullable<Awaited<ReturnType<typeof prisma.campaigns.findFirst>>>;
type GenMerchant = NonNullable<Awaited<ReturnType<typeof prisma.user_merchants.findFirst>>>;

interface GenContext {
  campaign_id: string;
  campaign: GenCampaign;
  merchant: GenMerchant;
  adGroupId: bigint | null;
  adCreativeId: bigint | null;
  initialCache: CrawlCache | null;
  originalMerchantUrl: string;
  country: string;
  optionalNeedsPromo: boolean;
  dbKeywordsForFallback: string[];
  types: string[];
  ad_language: string | undefined;
  requestKeywords: string[];
  body: { optionalTypes?: string[] };
  userId: bigint;
}

export async function loadGenContext(
  campaignIdRaw: string | number | bigint,
  userId: bigint,
  payload: GenerationRequestPayload,
): Promise<{ ctx: GenContext } | { error: string; status: number }> {
  const types = (payload.types || []) as string[];
  const ad_language = payload.ad_language ?? undefined;
  const requestKeywords = (payload.keywords || []) as string[];
  const body = { optionalTypes: (payload.optionalTypes || []) as string[] };

  const campaign = await prisma.campaigns.findFirst({
    where: { id: BigInt(campaignIdRaw), user_id: userId, is_deleted: 0 },
  });
  if (!campaign) return { error: "广告系列不存在", status: 404 };

  const merchant = await prisma.user_merchants.findFirst({
    where: { id: campaign.user_merchant_id, is_deleted: 0 },
  });
  if (!merchant) return { error: "商家不存在", status: 400 };

  const adGroup = await prisma.ad_groups.findFirst({
    where: { campaign_id: campaign.id, is_deleted: 0 },
    select: { id: true },
  });
  // C-082 Part A (RC-2)：预查 ad_group 上的正向关键词，作为 generateCore fallback 路径的 keywords 兜底。
  // 主路径用 confirmedKeywords（前端 body.keywords，员工已确认）；fallback 路径若 confirmedKeywords 为空，
  // 必须改用本数组，否则 padHeadlines 在零方向标下被品牌名 prior 拉偏（Yoin BE → 服装文案事故）。
  const dbKeywordsForFallback: string[] = adGroup
    ? (await prisma.keywords.findMany({
        where: { ad_group_id: adGroup.id, is_deleted: 0, is_negative: 0 },
        select: { keyword_text: true },
        orderBy: { id: "asc" },
        take: 12,
      })).map((k) => k.keyword_text.trim()).filter(Boolean)
    : [];
  const adCreative = adGroup
    ? await prisma.ad_creatives.findFirst({
      where: { ad_group_id: adGroup.id, is_deleted: 0 },
      select: { id: true, final_url: true, crawl_cache: true },
    })
    : null;

  // 优先使用用户明确设定的落地页 URL（用户可能已改成本地化路径如 /en-us/）
  // merchant_url 是商家层面的默认 URL，可能带旧地区前缀（如 /en-sg/）
  const originalMerchantUrl = adCreative?.final_url || merchant.merchant_url || "";
  const country = campaign.target_country || "US";
  const needsOptional = types.includes("optional");
  const optionalNeedsPromo = needsOptional && (body.optionalTypes || []).some((t: string) => ["promotion", "price"].includes(t));
  const adCreativeId = adCreative?.id || null;
  const initialCache = adCreative?.crawl_cache as CrawlCache | null;

  return {
    ctx: {
      campaign_id: String(campaign.id),
      campaign,
      merchant,
      adGroupId: adGroup?.id ?? null,
      adCreativeId,
      initialCache,
      originalMerchantUrl,
      country,
      optionalNeedsPromo,
      dbKeywordsForFallback,
      types,
      ad_language,
      requestKeywords,
      body,
      userId,
    },
  };
}

export function buildGenerationStream(ctx: GenContext): ReadableStream {
  const {
    campaign_id,
    campaign,
    merchant,
    adGroupId,
    adCreativeId,
    initialCache,
    originalMerchantUrl,
    country,
    optionalNeedsPromo,
    dbKeywordsForFallback,
    types,
    ad_language,
    requestKeywords,
    body,
    userId,
  } = ctx;

  const encoder = new TextEncoder();
  let isClosed = false;
  // D-063：整条生成（types 含 core）才走并发闸；sitelinks/optional/negkw 等局部补生成不占闸
  const isFullGeneration = (types as string[]).includes("core");
  const stream = new ReadableStream({
    async start(controller) {
      const send = (eventType: string, payload: unknown) => {
        if (isClosed) return;
        try { controller.enqueue(encoder.encode(`data: ${JSON.stringify({ type: eventType, data: serializeData(payload) })}\n\n`)); } catch { isClosed = true; }
      };
      // SSE keepalive：每 20s 发一个注释行，防止 Cloudflare 因 SSE 流静默超过 100s 关闭连接
      // （特别是爬取 bot-protected 商家时 buildCrawlCache 可占用 60-90s）
      const heartbeat = setInterval(() => {
        if (isClosed) { clearInterval(heartbeat); return; }
        try { controller.enqueue(encoder.encode(": keepalive\n\n")); } catch { isClosed = true; }
      }, 20000);

      // D-063：生成并发闸句柄（在 finally 释放）。心跳已先于此启动，排队期间连接不会断。
      let releaseGenerationSlot: (() => void) | null = null;

      try {
        // D-063：整条生成最多 2 条并行，超出则排队；排队时推 queued 事件让前端显示"排队中"
        // D-092：排队超时 180s→600s。D-090 起生成已是后台 job（排队不再占用任何用户连接），
        //   原 180s 会把硬挑战站点(avis.de 单条 60–90s+ 占满槽位)后排队的任务直接判 failed/截断；
        //   后台任务多等几分钟无副作用（前端轮询接续），故放宽到 10 分钟。
        if (isFullGeneration) {
          releaseGenerationSlot = await acquireGenerationSlot({
            timeoutMs: 600000,
            onQueued: (position) => {
              console.warn(`[Extensions] 生成并发闸排队中：前方 ${position} 个任务（campaign_id=${campaign_id}）`);
              send("queued", {
                position,
                message: `服务器繁忙，前方还有 ${position} 个生成任务，正在排队，请稍候…`,
              });
            },
          });
        }

        // 立即告知前端正在爬取中（避免前端因无事件超时）
        send("crawl_pending", { status: "crawling" });

        // ─── Step 1：国别 URL 解析（DNS + TCP，可能 5-30 s）───
        // C-016: aerosus.nl + BE → aerosus.be（若 DNS+TCP 通）
        const { resolveCountryUrl, extractBrandRoot } = await import("@/lib/country-url-resolver");
        const resolverResult = await resolveCountryUrl(originalMerchantUrl, country);
        let merchantUrl = resolverResult.finalUrl || originalMerchantUrl;
        const merchantName = extractBrandRoot(merchant.merchant_name || "");

        if (resolverResult.switched && adCreativeId) {
          console.warn(`[Extensions] C-016 ccTLD 切换: ${originalMerchantUrl} → ${merchantUrl}（reason=${resolverResult.reason}）`);
          await prisma.ad_creatives.update({
            where: { id: adCreativeId },
            data: { final_url: merchantUrl, crawl_cache: null as any },
          }).catch((e) => {
            console.warn("[Extensions] 写 final_url/清 cache 失败:", e instanceof Error ? e.message : e);
          });
        } else if (process.env.NODE_ENV !== "production") {
          console.log(`[Extensions] C-016 resolver reason=${resolverResult.reason}, switched=${resolverResult.switched}, brandRoot="${merchantName}"`);
        }

        // ─── Step 2：读取 ad_default_settings ───
        const adSettings = await prisma.ad_default_settings.findFirst({
          where: { user_id: userId, is_deleted: 0 },
          select: { ai_rule_profile: true, daily_budget: true, max_cpc: true, bidding_strategy: true },
        });
        const aiRuleProfile = (adSettings as any)?.ai_rule_profile;

        // ─── D-091：SemRush 关键词查询与爬虫并发启动 ───
        // 仅 core 首次自动生成（未携带员工已确认/编辑的关键词）时，在此并发启动 SemRush 关键词流水线，
        // 与下方 buildCrawlCache 同时跑——等爬虫完成时关键词通常已就绪，并复用同一次查询的 organic titles
        // 喂给文案编排（消除二次查询/减少 3UE 设备并发）。失败/超时不阻断文案（降级用爬取数据 + DB 兜底词）。
        // 改词「重新生成」（requestKeywords 非空）→ 跳过 SemRush 查询，直接用员工词，进一步省查询。
        const wantSemrushKeywords =
          (types as string[]).includes("core") &&
          (!Array.isArray(requestKeywords) || (requestKeywords as string[]).filter(Boolean).length === 0);
        const semrushKwBudget = Number(campaign.daily_budget) > 0 ? Number(campaign.daily_budget) : 2;
        const semrushKwMaxCpc = Number(campaign.max_cpc_limit) > 0 ? Number(campaign.max_cpc_limit) : 0.3;
        // 并发查询过程中复用给后续 cache 合并 / confirmedKeywords 的共享态（在 promise 内填充）
        let semrushSelectedPhrases: string[] = [];
        let semrushTitlesFromKw: string[] = [];
        let semrushDescFromKw: string[] = [];
        // 立即告知前端「关键词查询已启动」，避免面板显示「暂无关键词」误以为没跑
        if (wantSemrushKeywords) send("keywords_pending", { status: "querying" });
        // SemRush 与爬虫并发：SemRush 通常 10–40s 先于爬虫(60–90s)返回，一返回就立刻 emit + 落库（实时回填面板），
        // 不再等爬虫跑完才推送。失败/空 → emit keywords_failed。整体不阻断文案。
        const semrushKwPromise: Promise<SemrushKeywordsResult | null> = wantSemrushKeywords
          ? (async () => {
              let kwRes: SemrushKeywordsResult | null = null;
              try {
                kwRes = await fetchSemrushKeywords({
                  merchantUrl,
                  country,
                  merchantName,
                  dailyBudgetUsd: semrushKwBudget,
                  maxCpcUsd: semrushKwMaxCpc,
                });
              } catch (e) {
                console.warn("[Extensions] D-091 SemRush 关键词查询异常（降级不阻断）:", e instanceof Error ? e.message : e);
                kwRes = null;
              }
              if (kwRes && kwRes.ok && kwRes.keywords.length > 0) {
                semrushSelectedPhrases = kwRes.keywords.map((k) => k.phrase).filter(Boolean).slice(0, 10);
                semrushTitlesFromKw = Array.isArray(kwRes.dedupedTitles) ? kwRes.dedupedTitles : [];
                semrushDescFromKw = Array.isArray(kwRes.dedupedDescriptions) ? kwRes.dedupedDescriptions : [];
                // 实时 emit：前端复用 mergeSemrushKeywords 回填面板
                send("keywords", { keywords: kwRes.keywords, from_cache: kwRes.fromCache, cache_age_hours: kwRes.cacheAgeHours });
                // 实时落库（删旧插新，关页也不丢）
                if (adGroupId) {
                  const kwRows = kwRes.keywords
                    .map((k) => ({
                      ad_group_id: adGroupId,
                      keyword_text: String(k.phrase ?? "").trim(),
                      match_type: (k.recommended_match_type || "PHRASE").toUpperCase(),
                      avg_monthly_searches: k.volume != null && Number.isFinite(k.volume) ? Math.max(0, Math.round(k.volume)) : null,
                      suggested_bid: k.suggested_bid ?? (k.cpc ?? null),
                      competition: k.competition != null ? String(k.competition) : null,
                      source: k.source ?? null,
                    }))
                    .filter((d) => d.keyword_text.length > 0);
                  try {
                    await prisma.$transaction([
                      prisma.keywords.deleteMany({ where: { ad_group_id: adGroupId } }),
                      prisma.keywords.createMany({ data: kwRows, skipDuplicates: true }),
                    ]);
                  } catch (e) {
                    console.warn("[Extensions] D-091 关键词落库失败（不阻断）:", e instanceof Error ? e.message : e);
                  }
                }
                console.log(`[Extensions] D-091 SemRush 关键词就绪并实时推送 ${semrushSelectedPhrases.length} 个，titles=${semrushTitlesFromKw.length}，fromCache=${kwRes.fromCache}`);
              } else {
                const category = kwRes?.errorCategory || "timeout_or_empty";
                send("keywords_failed", { category, message: kwRes?.errorMessage || "" });
                console.warn(`[Extensions] D-091 SemRush 关键词未就绪（category=${category}），文案降级用爬取/兜底词`);
              }
              return kwRes;
            })()
          : Promise.resolve(null);

        // ─── Step 3：读取或构建爬取缓存（Puppeteer 可能 60-90 s）───
        // ccTLD 切换时需清空缓存（切换后新域名无缓存）
        let cache: CrawlCache | null = resolverResult.switched ? null : initialCache;

        const cachedPromo = cache?.promoRegex as Record<string, unknown> | null | undefined;
        const cachedPromoHasDiscount =
          (cachedPromo?.discount_percent ? Number(cachedPromo.discount_percent) : 0) > 0 ||
          (cachedPromo?.discount_amount ? Number(cachedPromo.discount_amount) : 0) > 0;
        const cacheNeedsRefreshForPromo = optionalNeedsPromo && !cachedPromoHasDiscount;

        const cacheLowQuality = typeof cache?.crawlQualityScore === "number" && cache.crawlQualityScore < 40;
        const cacheHasEmptyLinks = !cacheLowQuality && cache && (
          (Array.isArray(cache.links) && cache.links.length === 0) ||
          (cache.crawlQualityScore === undefined && Array.isArray(cache.links) && cache.links.length < 3)
        );

        // 旧脏 cache 兼容：score 是新增字段，部分历史数据评分 90 但 pageText=0
        // （SPA 站当初被 assessCrawlQuality 漏判）→ 用 pageText 长度独立判定，不依赖 score。
        const cachePageTextTooShort =
          !!cache && (cache.pageText ?? "").length < 200 &&
          (!Array.isArray(cache.semrushTitles) || cache.semrushTitles.length === 0);

        const forceRecrawlForSitelinks =
          (types as string[]).includes("sitelinks") && !(types as string[]).includes("core")
            ? true
            : (cache?.sitelinkCandidates?.length ?? 0) < 3 && !!cache;

        if (!cache || !cache.crawledAt || cache.crawlFailed || cacheNeedsRefreshForPromo || cacheLowQuality || cacheHasEmptyLinks || cachePageTextTooShort || forceRecrawlForSitelinks) {
          const reason = !cache || !cache.crawledAt ? '为空'
            : cache.crawlFailed ? '上次失败'
            : cacheLowQuality ? `质量低（score=${cache.crawlQualityScore}, issues=[${cache.crawlQualityIssues?.join(",")}]）`
            : cacheHasEmptyLinks ? 'links 为空（旧缓存命中 splash 页）'
            : cachePageTextTooShort ? `pageText 过短 (${(cache.pageText ?? "").length}<200) 且无 SemRush，旧脏 cache 重爬`
            : forceRecrawlForSitelinks ? `用户点重新爬取 or sitelinkCandidates(${cache?.sitelinkCandidates?.length ?? 0})<3`
            : '缓存促销无有效折扣，重爬';
          console.log(`[Extensions] crawl_cache ${reason}，重新爬取... forcePuppeteer=${cacheNeedsRefreshForPromo}`);
          // C-027 FIX-B：同一 merchantUrl × country 并发去重（共享同一个 Promise）
          const crawlKey = buildCrawlKey(merchantUrl, country);
          // D-038b（2026-05-28，方案 G）：删除 D-028 v9 / D-031 / D-031b2 引入的外层 Promise.race
          // 强制砍切 + timeout-stub 占位 cache 的"假成功"机制。
          //
          // 删除原因：
          // ①D-031b2 把外层 timeout 调到 180s/200s 后，buildCrawlCache 内层 puppeteer 跑完
          //  自然 60-120s，本来正常完成，但 race 机制制造了"timeout-stub"占位 cache
          //  伪装成功（crawlFailed=true），再被 L2 守门 emit context_insufficient 拦截，
          //  形成"全员看到网站爬取失败"假象。
          // ②真实失败（puppeteer 全死 / 网络挂）应该走 buildCrawlCache 内部错误处理，
          //  throw 真实错误后被外层 catch 设为 crawlFailed=true，而不是 race timeout 后
          //  伪造一个看似 schema 完整的 stub cache 让下游误认为"爬到了什么"。
          // ③5/25 之前（D-028/D-031 commit 链之前）没有外层 race 也跑得通，91.7% 成功率。
          //
          // 现行为：
          //   - buildCrawlCache 自然完成 → 真实返回（无论 ok 还是 partial）
          //   - 内部抛错 → 外层 catch 设 crawlFailed=true 走真实失败路径
          //   - 极端 hang 兜底：300s（5 分钟）防 puppeteer 死锁，仅作 safety net
          //     不再当作"业务超时降级"，hang 触发时直接 throw 真实错误
          //
          // D-090（后台 job 化后）：生成不再占用用户长连接，但仍要防止单条生成把 generation-gate
          // 的并发槽长时间占死（300s）拖垮排队。故把 crawl 预算从 300s 收紧到 90s——
          // 超时不再 throw 让整条生成失败，而是降级为 crawlFailed cache 继续：
          // 下游 D-083b SemRush 兜底 + 编排器自身的 SemRush 路径仍可产出文案；
          // 若 SemRush 也无数据，则由 L2 守门给出明确的 context_insufficient 提示（诚实失败）。
          const HANG_SAFETY_MS = 90000;
          const LOCK_TIMEOUT_MS_LOCAL = HANG_SAFETY_MS + 10000;
          const buildStartedAt = Date.now();
          console.log(`[Extensions] D-090：buildCrawlCache 启动 crawl_budget=${HANG_SAFETY_MS / 1000}s（超时降级出文案）merchantUrl=${merchantUrl}`);
          const newCache: CrawlCache = await withCrawlInflightLock(crawlKey, async () => {
            const hangSafety = new Promise<CrawlCache>((_, reject) =>
              setTimeout(
                () => reject(new Error("buildCrawlCache-hang-safety")),
                HANG_SAFETY_MS,
              ).unref?.(),
            );
            try {
              const result = await Promise.race([
                buildCrawlCache(merchantUrl, merchantName, country, undefined, {
                  forcePuppeteer: cacheNeedsRefreshForPromo,
                }),
                hangSafety,
              ]);
              const elapsedMs = Date.now() - buildStartedAt;
              console.log(`[Extensions] D-038b：buildCrawlCache 自然完成 elapsedMs=${elapsedMs}ms merchantUrl=${merchantUrl}`);
              return result;
            } catch (err) {
              const msg = err instanceof Error ? err.message : String(err);
              const elapsedMs = Date.now() - buildStartedAt;
              if (msg === "buildCrawlCache-hang-safety") {
                // D-090：crawl 预算超时（90s）→ 降级为 crawlFailed cache 继续生成，
                // 不再 throw 让整条生成失败（后台 job 化后无长连接可断，但要释放并发槽）。
                console.error(`[Extensions] D-090：buildCrawlCache 超过 ${HANG_SAFETY_MS / 1000}s 预算，降级为 crawlFailed cache 继续（SemRush/编排器兜底出文案）elapsedMs=${elapsedMs}ms merchantUrl=${merchantUrl}`);
                return {
                  links: [], images: [], pageText: "", features: [], navItems: [],
                  phoneCandidates: [], sitelinkCandidates: [], semrushTitles: [], semrushDescriptions: [],
                  promoRegex: null, priceRegex: [], crawledProducts: [],
                  crawledAt: new Date().toISOString(), crawlMethod: "timeout-degraded", crawlFailed: true,
                  crawlQualityScore: 0, crawlQualityIssues: ["crawl_budget_timeout"],
                } as CrawlCache;
              }
              console.warn(`[Extensions] D-038b：buildCrawlCache 真实失败 elapsedMs=${elapsedMs}ms msg=${msg}`);
              throw err;
            }
          }, LOCK_TIMEOUT_MS_LOCAL);
          const newPromo = newCache.promoRegex as Record<string, unknown> | null;
          const newHasDiscount = (newPromo?.discount_percent ? Number(newPromo.discount_percent) : 0) > 0 ||
            (newPromo?.discount_amount ? Number(newPromo.discount_amount) : 0) > 0;
          const shouldSave = newHasDiscount || !cachedPromoHasDiscount;
          cache = newCache;
          if (adCreativeId && shouldSave) {
            const freshRecord = await prisma.ad_creatives.findFirst({ where: { id: adCreativeId }, select: { crawl_cache: true } }).catch(() => null);
            const freshPromo = (freshRecord?.crawl_cache as any)?.promoRegex as Record<string, unknown> | null;
            const freshHasDiscount = (freshPromo?.discount_percent ? Number(freshPromo.discount_percent) : 0) > 0 ||
              (freshPromo?.discount_amount ? Number(freshPromo.discount_amount) : 0) > 0;
            if (!freshHasDiscount || newHasDiscount) {
              await prisma.ad_creatives.update({
                where: { id: adCreativeId },
                data: { crawl_cache: cache as any },
              }).catch(() => {});
              console.log(`[Extensions] cache 已保存，newHasDiscount=${newHasDiscount}`);
            } else {
              cache = freshRecord!.crawl_cache as any;
              console.log(`[Extensions] 保留 DB 中更好的 cache（已有折扣）`);
            }
          }
        }

        // C-016: 路径级 locale 写回（/en-sg/ → /en-us/）
        const localizedUrl = (cache as CrawlCache | null)?.localizedMerchantUrl;
        if (localizedUrl && localizedUrl !== merchantUrl && adCreativeId) {
          const prevUrl = merchantUrl;
          merchantUrl = localizedUrl;
          await prisma.ad_creatives.update({
            where: { id: adCreativeId },
            data: { final_url: localizedUrl },
          }).catch(() => {});
          console.log(`[Extensions] 路径级 locale 命中: ${prevUrl} → ${localizedUrl}`);
        }

        // ─── Step 4：推送爬取状态 + 开始生成 ───
        send("crawl_status", { crawl_failed: cache!.crawlFailed, crawl_method: cache!.crawlMethod });

        if (cache!.detectedLanguageCode) {
          send("detected_language", { code: cache!.detectedLanguageCode });
          console.log(`[Extensions] 推送检测到的页面语言: ${cache!.detectedLanguageCode}`);
        }

        const tasks: Promise<void>[] = [];

        // ─── D-091：合流 SemRush organic titles 入 cache（emit/落库已在并发 promise 内实时完成）───
        // SemRush 通常已先于爬虫返回——并发 promise 那时就 send("keywords") + 落库 + 填好 semrush* 共享态。
        // 这里只做爬虫完成后的收尾：等 promise 结束（封顶 8s，正常即时），把 organic titles 复用进 cache，
        // 供编排器/L2 守门，并让下方 D-083b 不再二次查询。失败/空不阻断（confirmedKeywords 见 core 分支）。
        if (wantSemrushKeywords) {
          await Promise.race([
            semrushKwPromise.catch(() => null),
            new Promise((r) => { const t = setTimeout(() => r(null), 8000); t.unref?.(); }),
          ]);
          if (
            semrushTitlesFromKw.length > 0 &&
            (!Array.isArray(cache!.semrushTitles) || cache!.semrushTitles.length === 0)
          ) {
            (cache as any).semrushTitles = semrushTitlesFromKw;
            (cache as any).semrushDescriptions = semrushDescFromKw;
            if (adCreativeId) {
              await prisma.ad_creatives.update({
                where: { id: adCreativeId },
                data: { crawl_cache: cache as any },
              }).catch(() => {});
            }
          }
        }

        // ─── D-083b：SemRush 守门前兜底 ────────────────────────────────────────────
        // buildCrawlCache 调用处始终传 semrushData=undefined，故 cache.semrushTitles 永远 []。
        // 当爬虫失败（pageText 极短）时，L2 守门因 semrushTitles=0 误拦了编排器（编排器
        // 自己会查 SemRush，但守门比它先跑）。
        // 修法：守门前若 pageText<200 且 semrushTitles=0，先补一次 SemRush 查询；
        //       有数据则写回内存 cache + 持久化，守门得到真实计数再做判断。
        if ((cache!.pageText ?? "").length < 200 &&
            (Array.isArray(cache!.semrushTitles) ? cache!.semrushTitles.length : 0) === 0) {
          try {
            const { SemRushClient } = await import("@/lib/semrush-client");
            const _srClient = await SemRushClient.fromConfig(country);
            const _srResult = await _srClient.queryDomain(merchantUrl);
            if (_srResult.dedupedTitles.length > 0 || _srResult.keywords.length > 0) {
              (cache as any).semrushTitles = _srResult.dedupedTitles;
              (cache as any).semrushDescriptions = _srResult.dedupedDescriptions;
              console.log(`[D-083b] SemRush 兜底补足 semrushTitles=${_srResult.dedupedTitles.length} keywords=${_srResult.keywords.length}（爬虫失败时 L2 守门兜底）`);
              if (adCreativeId) {
                await prisma.ad_creatives.update({
                  where: { id: adCreativeId },
                  data: { crawl_cache: cache as any },
                }).catch((e: unknown) => console.warn("[D-083b] semrushTitles 回写 cache 失败:", e instanceof Error ? e.message : e));
              }
            }
          } catch (e: unknown) {
            console.warn("[D-083b] SemRush 兜底查询失败（不阻断，L2 守门按原逻辑判断）:", e instanceof Error ? e.message : e);
          }
        }

        // ─── L2: 上下文不足守门 ───
        // 当爬虫拿到的 pageText 极短（< 200 字符，L3 meta 兜底后仍空）+ SemRush 标题为 0
        // + 没爬到任何商品时，AI 输入只剩商家名，会从字面瞎猜业务（如 Camplify→Spa）。
        // 此时不再调用 AI，而是直接给员工一个明确的错误提示，让人工介入。
        const ctxPageTextLen = (cache!.pageText ?? "").length;
        const ctxSemrushTitles = Array.isArray(cache!.semrushTitles) ? cache!.semrushTitles.length : 0;
        const ctxProducts = Array.isArray((cache as any).crawledProducts) ? (cache as any).crawledProducts.length : 0;
        const ctxFeatures = Array.isArray(cache!.features) ? cache!.features.length : 0;
        const ctxInsufficient =
          ctxPageTextLen < 200 &&
          ctxSemrushTitles === 0 &&
          ctxProducts === 0 &&
          ctxFeatures < 3;

        const merchantCategory = merchant.category ?? null;

        // ─── L1.5 D-069：商家网址即"域名停放/待售页"硬拦截 ───
        // resolver 的 probeParkedPage 只校验 ccTLD 候选，挡不住商家主域本身被停放/挂售的情况
        // （如 heidi.uk/scarosso.de 之外，商家自己填的 .com 也可能已是停放页）。此时爬到的 pageText
        // 内容很多但全是"卖域名"，会被 AI 写成卖域名广告。命中高精度停放信号 → 直接停掉 core 生成，
        // 给员工明确提示（修正商家网址），而不是生成与业务无关的文案。
        const parkedSignalHit =
          matchParkedTextSignal(cache!.pageText) ||
          (Array.isArray(cache!.crawlQualityIssues) && cache!.crawlQualityIssues.includes("parked_page")
            ? "crawl_quality:parked_page"
            : null);

        if (parkedSignalHit && types.includes("core")) {
          console.warn(
            `[Extensions] L1.5 D-069 触发：商家网址疑似域名停放/待售页（signal=${parkedSignalHit} url=${merchantUrl}），停掉 core 文案生成`,
          );
          send("merchant_url_parked", {
            url: merchantUrl,
            signal: parkedSignalHit,
            reason: "商家网址当前是『域名停放/待售页』（非真实店铺页面），按此页面生成会得到与业务无关的『卖域名』广告",
            suggestion: "请在『商家库』把该商家网址改为其真实在线店铺地址后，再回来重新生成文案",
          });
          // 与正常路径一致用 [DONE] 终止符收尾；controller.close()/释放生成闸由外层 finally 统一处理
          if (!isClosed) {
            try { controller.enqueue(encoder.encode("data: [DONE]\n\n")); } catch { isClosed = true; }
          }
          return;
        }

        if (ctxInsufficient && types.includes("core")) {
          console.warn(
            `[Extensions] L2 守门触发：上下文不足（pageText=${ctxPageTextLen} semrush=${ctxSemrushTitles} products=${ctxProducts} features=${ctxFeatures}），跳过 AI 文案生成`,
          );
          send("context_insufficient", {
            page_text_len: ctxPageTextLen,
            semrush_titles: ctxSemrushTitles,
            products: ctxProducts,
            features: ctxFeatures,
            reason: cache!.crawlFailed
              ? "网站爬取失败"
              : "网站为 SPA 或反爬保护，主页内容无法解析",
            suggestion: "请尝试『重新爬取』或在『商家库』中手动补充商家网站描述后再生成文案",
          });
          // 守门仍保留图片提取：员工至少能拿到 logo/banner
          if (types.includes("core")) {
            tasks.push((async () => {
              try {
                const rawImgs = cache!.images || [];
                const images = rawImgs.length > 0
                  ? await selectBestImages(rawImgs, merchantUrl, { pageText: cache!.pageText, features: cache!.features })
                  : [];
                send("images", images);
                if (adCreativeId && images.length > 0) {
                  await prisma.ad_creatives.update({
                    where: { id: adCreativeId },
                    data: { image_urls: images as any },
                  }).catch(() => {});
                }
              } catch (imgErr) {
                console.warn("[Extensions] L2 守门：图片提取异常:", imgErr instanceof Error ? imgErr.message : imgErr);
                send("images", []);
              }
            })());
          }
          // 跳过 generateCore，但继续走 optional 和 sitelinks 已有逻辑（这些都依赖 cache，没有上下文也无法生成）
          // 不进入主 if 分支，跳过下面的 generateCore
        } else if (types.includes("core")) {
          // D-091：员工改词重生成优先用员工词；首次自动生成则用并发 SemRush 选出的词
          const confirmedKeywords =
            Array.isArray(requestKeywords) && (requestKeywords as string[]).filter(Boolean).length > 0
              ? (requestKeywords as string[]).filter(Boolean).slice(0, 10)
              : semrushSelectedPhrases;
          // C-112 / D-046.C：8 步 AI 智能闭环（完全替换原 generateCore 主路径）
          //   - Step 1 reachability  → Step 2 crawl（已 cache）→ Step 3 AI 画像
          //   - Step 4 政策 pre-flight → Step 5 关键词 5 源 + 三因子 match type
          //   - Step 6 RAG 证据约束 prompt → Step 7 cosine ≥ 0.7 评分 + 返工
          //   - Step 8 D-039 H3 兜底剔除 critical
          // 旧 generateCore 保留为应急 fallback：orchestrator 严重失败时降级，业务不挂。
          tasks.push(runIntelligentCore(
            cache!,
            merchant,
            campaign,
            merchantName,
            merchantUrl,
            country,
            adSettings,
            aiRuleProfile,
            adCreativeId,
            send,
            ad_language,
            confirmedKeywords,
            merchantCategory,
            dbKeywordsForFallback,
          ));

          // F-15: 图片提取独立于 AI 生成流程，并行运行，避免 AI/OCR 异常导致图片丢失
          tasks.push((async () => {
            try {
              let rawImgs = cache!.images || [];
              // D-059: 爬取阶段 0 图时最后兜底——直接 HTTP 抓商家首页提图（多 UA + og:image + JSON-LD +
              // 相对 URL 解析）。解决 Puppeteer/代理那趟未拿到图、但站点 HTML 明明有图的情况（如 WordPress 站）。
              if (rawImgs.length === 0 && merchantUrl) {
                try {
                  const { fetchPageImages } = await import("@/lib/crawler");
                  const fb = await fetchPageImages(merchantUrl);
                  if (fb.length > 0) {
                    rawImgs = fb;
                    console.warn(`[Extensions] D-059 raw=0 兜底 fetchPageImages 抓到 ${fb.length} 张`);
                  }
                } catch (fbErr) {
                  console.warn("[Extensions] D-059 兜底 fetchPageImages 失败:", fbErr instanceof Error ? fbErr.message : fbErr);
                }
              }
              // D-095b：Shopify 商家——优先从产品页 .js 抓干净产品图，置顶注入选图池
              // （营销首页常只有 lifestyle/信任徽章/截图，产品图不在首页）。非 Shopify 站返回空。
              let productImgs: string[] = [];
              try { productImgs = await collectShopifyProductImages(merchantUrl, cache!); } catch (e) {
                console.warn("[Extensions] D-095b Shopify 产品图采集失败（不阻断）:", e instanceof Error ? e.message : e);
              }
              const imgPool = productImgs.length > 0 ? [...productImgs, ...rawImgs] : rawImgs;
              const images = imgPool.length > 0
                ? await selectBestImages(imgPool, merchantUrl, { pageText: cache!.pageText, features: cache!.features, priorityImages: productImgs })
                : [];
              send("images", images);
              if (adCreativeId && images.length > 0) {
                await prisma.ad_creatives.update({
                  where: { id: adCreativeId },
                  data: { image_urls: images as any },
                }).catch((e) => console.warn("[Extensions] image_urls 写入失败:", e instanceof Error ? e.message : e));
              }
              console.warn(`[Extensions] 图片提取完成: ${images.length} 张 (raw=${rawImgs.length})`);
            } catch (imgErr) {
              console.warn("[Extensions] 图片提取异常（不阻断生成）:", imgErr instanceof Error ? imgErr.message : imgErr);
              send("images", []);
            }
          })());
        }

        if (types.includes("optional")) {
          const optionalTypes: string[] = body.optionalTypes || [];
          tasks.push(generateOptionalBatch(cache!, merchantName, merchantUrl, country, optionalTypes, aiRuleProfile, send, ad_language));
        }

        if (types.includes("sitelinks") && !types.includes("core")) {
          tasks.push(
            generateSitelinksOnly(
              cache!,
              merchantName,
              merchantUrl,
              country,
              adCreativeId,
              send,
              ad_language,
            ),
          );
        }

        await Promise.all(tasks);
        if (!isClosed) {
          try { controller.enqueue(encoder.encode("data: [DONE]\n\n")); } catch { isClosed = true; }
        }
      } catch (err) {
        if (!isClosed) {
          const code = (err as Error & { code?: string })?.code;
          if (code === "GENERATION_SLOT_TIMEOUT") {
            console.warn("[Extensions] 生成并发闸排队超时:", err instanceof Error ? err.message : err);
            try { controller.enqueue(encoder.encode(`data: ${JSON.stringify({ type: "error", data: "服务器繁忙，排队超时，请稍后重试" })}\n\n`)); } catch { isClosed = true; }
          } else {
            console.error("[Extensions] 流式生成未捕获异常:", err instanceof Error ? err.message : err);
            try { controller.enqueue(encoder.encode(`data: ${JSON.stringify({ type: "error", data: "生成失败，请重试" })}\n\n`)); } catch { isClosed = true; }
          }
        }
      } finally {
        clearInterval(heartbeat);
        // D-063：释放生成并发闸，唤醒队列中的下一条生成
        if (releaseGenerationSlot) {
          try { releaseGenerationSlot(); } catch { /* noop */ }
          releaseGenerationSlot = null;
        }
        if (!isClosed) {
          isClosed = true;
          try { controller.close(); } catch {}
        }
      }
    },
    cancel() {
      isClosed = true;
    },
  });

  return stream;
}

// ───────────────────────────────────────────────────────────────
// POST：旧 SSE 长连接链路（D-090 灰度回滚 fallback）。
// 默认前端走 /generate-start + /generate-status 后台任务；仅当
// GENERATION_ASYNC_OFF=1 时 /generate-start 返回 { fallback:true }，
// 前端回退到直接调用本路由（行为与重构前逐字节一致）。
// ───────────────────────────────────────────────────────────────
export async function POST(req: NextRequest) {
  const user = getUserFromRequest(req);
  if (!user) return apiError("未授权", 401);

  let body: any;
  try {
    body = await req.json();
  } catch (e) {
    console.error("[Extensions] 请求体 JSON 解析失败:", e instanceof Error ? e.message : e);
    return apiError("请求体格式错误");
  }
  const { campaign_id, types = [], ad_language, keywords: requestKeywords = [] } = body;
  if (!campaign_id) {
    console.warn("[Extensions] 400: 缺少 campaign_id, body:", JSON.stringify(body).slice(0, 200));
    return apiError("缺少 campaign_id");
  }
  if (!types.length) {
    console.warn("[Extensions] 400: 缺少 types, campaign_id:", campaign_id);
    return apiError("缺少 types");
  }

  const loaded = await loadGenContext(campaign_id, BigInt(user.userId), {
    types,
    ad_language,
    keywords: requestKeywords,
    optionalTypes: body.optionalTypes || [],
  });
  if ("error" in loaded) {
    console.warn(`[Extensions] ${loaded.status}: ${loaded.error}, campaign_id=${campaign_id}`);
    return apiError(loaded.error, loaded.status);
  }

  return new Response(buildGenerationStream(loaded.ctx), {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      "X-Accel-Buffering": "no",
      // 禁止 Cloudflare 对此接口使用 QUIC/HTTP3，避免 ERR_QUIC_PROTOCOL_ERROR
      "Alt-Svc": "clear",
    },
  });
}

// ─── Core 生成：标题 + 描述 + 站内链接描述 + 图片（1 次 AI） ───

async function generateCore(
  cache: CrawlCache,
  merchantName: string,
  merchantUrl: string,
  country: string,
  adSettings: any,
  aiRuleProfile: unknown,
  adCreativeId: bigint | null,
  send: (type: string, data: unknown) => void,
  adLanguageCode?: string,
  confirmedKeywords: string[] = [],
  merchantCategory: string | null = null,
  dbKeywordsForFallback: string[] = [],
) {
  const market = getAdMarketConfig(country);
  const languageName = resolveLanguageName(country, adLanguageCode);
  const dailyBudget = Number(adSettings?.daily_budget || 2);
  const maxCpc = Number(adSettings?.max_cpc || 0.3);

  // ─── L1: 业务摘要（提前并行触发，与 sitelinkPipeline 一起跑，不阻塞主 AI prompt 准备） ───
  // 用 haiku 现场提炼 30-150 字主营业务摘要，让主 AI prompt 一开始就知道商家"实际是干嘛的"，
  // 根治 Camplify→Spa 这种业务漂移。
  // 注意：故意 不持久化、不复用 —— 广告创建本身就需要差异化，每次摘要轻微抖动有助于
  //       AI 在多次"重新生成"间产出不同角度的文案，否则同一 prompt 会让标题趋同。
  const businessSummaryPromise = (async () => {
    try {
      const { extractBusinessSummary } = await import("@/lib/business-summary");
      const summary = await extractBusinessSummary({
        merchantName,
        merchantUrl,
        category: merchantCategory,
        pageText: cache.pageText || "",
        features: cache.features || [],
        countryName: market.countryNameZh,
      });
      if (summary) {
        console.log(`[Core] L1 业务摘要现场生成: confidence=${summary.confidence}, len=${summary.summary_en.length}`);
      }
      return summary;
    } catch (err) {
      console.warn("[Core] L1 业务摘要提炼失败（非阻断）:", err instanceof Error ? err.message : err);
      return null;
    }
  })();
  const biddingStrategy = adSettings?.bidding_strategy || "MAXIMIZE_CLICKS";

  // ═════════════════════════════════════════════════════════════════
  // C-016: sitelink 独立 pipeline（与主 AI 流并行，不阻塞 headlines/descriptions）
  //   1) discover + autoExpandSitelinks 扩源到 ≥ 6 条真实页面 URL
  //   2) 调用 sitelink-ai-writer 独立 AI，根据页面 meta 写 title/desc1/desc2
  //   3) 只在候选收齐 + AI 写完后**一次性** send("sitelinks", final)
  //   4) 不再推"空 sitelinks"让前端过早显示"未找到"
  // ═════════════════════════════════════════════════════════════════
  const sitelinkPipeline = (async () => {
    try {

      const baseline = (cache.sitelinkCandidates || []).map((s) => ({
        url: s.url,
        title: s.title,
        description: s.description,
      }));
      const expanded = await autoExpandSitelinks({
        merchantUrl,
        country,
        existing: baseline,
        targetCount: 6,
      });

      // 去重（保序），最多取前 8 条作为 AI 输入缓冲
      const unique: typeof expanded = [];
      const seen = new Set<string>();
      for (const s of expanded) {
        const norm = s.url.replace(/\/$/, "").replace(/^http:/, "https:").toLowerCase();
        if (seen.has(norm)) continue;
        seen.add(norm);
        unique.push(s);
        if (unique.length >= 8) break;
      }

      if (unique.length === 0) {
        console.warn(`[Core] C-016 sitelink pipeline: 无候选，推送空 sitelinks`);
        send("sitelinks", []);
        return [] as Array<{ url: string; title: string; desc1: string; desc2: string }>;
      }

      const aiInputs = unique.map((s) => ({
        url: s.url,
        pageTitle: s.title,
        pageDescription: s.description,
      }));
      const written = await generateSitelinkTexts(aiInputs, {
        brandRoot: merchantName,
        country,
        languageCode: adLanguageCode || market.languageCode,
      });
      // C-032 QA-1 A：第二层过滤——AI 输出后再过一遍黑名单，防止扩源阶段混入低价值链接
      const filtered = written.filter((s) => !isLowValueSitelink(s.url, s.title));
      if (filtered.length < written.length) {
        console.warn(`[SitelinkFilter] L2 过滤 AI 输出: 原 ${written.length} 条 → 保留 ${filtered.length} 条`);
      }
      const final = filtered.slice(0, 6);

      send("sitelinks", final);
      if (adCreativeId) {
        await prisma.ad_creatives
          .update({ where: { id: adCreativeId }, data: { sitelinks: final as any } })
          .catch((e) => {
            console.warn("[Core] sitelink 持久化失败:", e instanceof Error ? e.message : e);
          });
      }
      console.warn(
        `[Core] C-016 sitelink pipeline: discover=${baseline.length} expanded=${expanded.length} ai_written=${written.length} final=${final.length}`,
      );
      return final;
    } catch (e) {
      console.warn("[Core] sitelink pipeline 异常（推空）:", e instanceof Error ? e.message : e);
      send("sitelinks", []);
      return [] as Array<{ url: string; title: string; desc1: string; desc2: string }>;
    }
  })();

  const semrushBlock = cache.semrushTitles.length > 0
    ? `\nCompetitor headline references (inspiration only, do NOT copy):\n${cache.semrushTitles.slice(0, 8).map((t, i) => `${i + 1}. "${t}"`).join("\n")}\n`
    : "";

  // 根据爬取数据判断是否有真实折扣/物流信息
  const hasRealDiscount = cache.promoRegex && (cache.promoRegex.discount_type === "PERCENT" || cache.promoRegex.discount_type === "MONETARY");
  const hasRealFreeShipping = cache.features.some((f) => /free\s*ship|free\s*deliver/i.test(f));
  const hasGenericPromo = cache.promoRegex && !hasRealDiscount;

  let discountGuidance = "";
  if (hasRealDiscount && cache.promoRegex) {
    const promoData = cache.promoRegex;
    if (promoData.discount_type === "PERCENT") {
      discountGuidance = `\nThe website has a VERIFIED ${promoData.discount_percent}% discount — you may reference this exact number.`;
    } else if (promoData.discount_type === "MONETARY") {
      discountGuidance = `\nThe website has a VERIFIED ${promoData.currency_code || ""}${promoData.discount_amount} discount — you may reference this exact amount.`;
    }
  } else if (hasGenericPromo) {
    discountGuidance = "\nThe website appears to have general promotions/deals. You may mention 'deals available' or 'special offers' but do NOT fabricate specific discount numbers.";
  } else {
    discountGuidance = "\nNo verified discount was found on the website. Do NOT mention any specific discounts, percentages, or savings amounts. Focus on product quality, brand trust, and value instead.";
  }

  const shippingGuidance = hasRealFreeShipping
    ? "\nFree shipping was detected on the website — you may mention it."
    : "\nNo free shipping was confirmed on the website. Do NOT claim free shipping unless it is explicitly stated in the website content above.";

  // 爬虫提取的真实产品数据，传给 AI 作为写文案的素材
  const crawledProducts = (cache as any).crawledProducts || [];
  const productBlock = crawledProducts.length > 0
    ? `\nReal products found on website (use these names and prices as copy anchors):\n${crawledProducts.slice(0, 15).map((p: any, i: number) => `${i + 1}. "${p.name}"${p.price ? ` — ${p.currency || market.currencyCode}${p.price}` : ""}`).join("\n")}\n`
    : "";

  // 价格区间分析（给 AI 真实的价格锚点）
  const prices = crawledProducts.map((p: any) => Number(p.price)).filter((n: number) => n > 0).sort((a: number, b: number) => a - b);
  const priceRangeBlock = prices.length >= 2
    ? `\nPrice range on site: ${market.currencyCode}${prices[0]} – ${market.currencyCode}${prices[prices.length - 1]} (median ~${market.currencyCode}${prices[Math.floor(prices.length / 2)]}). Use these real prices as anchors ("From ${market.currencyCode}${prices[0]}", etc.).\n`
    : prices.length === 1
    ? `\nEntry price on site: ${market.currencyCode}${prices[0]}. You may reference this.\n`
    : "";

  // 确认关键词块（员工已确认的高意图词）
  const keywordsBlock = confirmedKeywords.length > 0
    ? `\n⚡ CONFIRMED HIGH-INTENT KEYWORDS (employee-selected, build multiple headlines around these):\n${confirmedKeywords.map((k, i) => `${i + 1}. ${k}`).join("\n")}\nAt least 3 headlines MUST directly mirror or include these keywords.\n`
    : "";

  const isNonEnglish = market.languageCode !== "en";
  const langEnforcement = isNonEnglish
    ? `\n⚠️ CRITICAL LANGUAGE RULE: ALL output (headlines + descriptions) MUST be written ENTIRELY in ${languageName}. Do NOT use English. Do NOT mix languages. Even if the source website content or examples below are in English, you MUST translate and localize everything into ${languageName}. The target audience speaks ${languageName} — all copy must feel native to them.\n`
    : "";

  // 动态读取激活人设
  const { normalizeAiRuleProfile, getActivePersona } = await import("@/lib/ai-rule-profile");
  const normalizedProfile = normalizeAiRuleProfile(aiRuleProfile);
  const activePersona = getActivePersona(normalizedProfile);

  // L1: 等业务摘要准备完毕（与 sitelinkPipeline 同期并行触发），注入到 prompt 顶部
  const businessSummary = await businessSummaryPromise;
  const { formatBusinessSummaryBlock } = await import("@/lib/business-summary");
  const businessSummaryBlock = formatBusinessSummaryBlock(businessSummary, merchantCategory);

  // D-039 H2：行业感知（高敏感品类强制注入中性词模板）
  const { detectIndustryProfile, buildIndustryPromptHint } = await import("@/lib/industry-profile");
  const industryProfile = detectIndustryProfile({
    merchantName,
    category: merchantCategory,
    pageText: cache.pageText,
  });
  const industryPromptHint = buildIndustryPromptHint(industryProfile);
  if (industryProfile) {
    console.log(`[Extensions] D-039 H2 industry detected: ${industryProfile.id} (${industryProfile.label}) for ${merchantName}`);
  }

  // ─── system message：人设身份 + 写作信条 + 禁忌（AI 角色定义，最高优先级）
  const systemPrompt = `You are ${activePersona.name} — ${activePersona.persona}

${formatAiRuleBlock(aiRuleProfile, "ad_copy")}

${AD_COPY_ANTI_AI_BLOCK}

IRON IDENTITY RULE: You are NOT a generic copywriting tool. You are ${activePersona.name}. Every word you output must reflect your persona's philosophy and craft standards. If a line you write could belong to any other brand or any other copywriter — delete it and rewrite it. Only output lines that could ONLY come from you, for THIS specific merchant.`;

  // ─── user message：商家数据 + 任务规格（每次请求变化的内容）
  const prompt = `Your single mission: write ad copy that converts cold searchers into buyers for THIS specific merchant.
${langEnforcement}
═══ NON-NEGOTIABLE RULES ═══
1. POLICY COMPLIANCE FIRST: Assess whether the merchant's product could trigger Google Ads restricted content policies. If ambiguous, ONLY use language that clearly describes the LEGAL use case.
2. SPECIFICITY OVER GENERICS: Every headline must contain at least ONE specific fact (price, year, material, collection name, feature). Headlines like "Best Quality" or "Shop Now" are REJECTED.
3. KEYWORD-FIRST: Mirror confirmed keywords in headlines. If a keyword could trigger a policy violation, reframe it safely.
4. DATA INTEGRITY: Use ONLY the facts provided below. Never invent discounts, prices, or product names.
5. ZERO AI CLICHÉS: Banned words: premium, top-quality, perfect, amazing, cutting-edge, seamless, elevate, unlock. Use real product/brand language instead.
6. HEADLINES ONLY — ABSOLUTE PROHIBITIONS (no exceptions, no persona overrides):
   · NO return/refund/money-back language in headlines. Put it in descriptions if needed.
     ✗ "Free Returns on All Orders" / "30-Day Money-Back Guarantee" → REJECTED from headlines
   · NO discount codes or promo codes in headlines. Ever.
     ✗ "Use Code SAVE20" / "Enter Promo Code for 20% Off" → REJECTED from headlines
     ✓ Verified percentage off ("20% Off Sitewide") is allowed in headlines if confirmed on the website.
7. TRADEMARK COMPLIANCE — MANDATORY (affiliate marketing context):
   · Do NOT use the exact merchant brand name "${merchantName}" in ANY headline or description.
   · Do NOT use the founder's / designer's personal name in any headline or description.
   · This system runs in an affiliate marketing context. Using a trademarked brand name or person's name
     in ad copy violates Google Ads trademark policy and will cause the entire ad to be REJECTED.
   · Instead, describe WHAT the merchant sells using functional/category language:
     ✗ "${merchantName} Exclusive Deals" / "${merchantName} 獨家規劃" → TRADEMARK VIOLATION
     ✓ "Curated Travel Packages" / "精選全球旅遊行程" → COMPLIANT
   · If the brand name appears in website content, use it as context only — never quote it in output.
8. CAPITALIZATION COMPLIANCE — MANDATORY (Google Ads policy):
   · Headlines must follow standard English Title Case rules:
     – Capitalize: nouns, verbs, adjectives, adverbs, and the first word of the headline.
     – Do NOT capitalize in the MIDDLE of a headline: prepositions (of, in, for, to, at, by, with,
       on, from, as, into, through, about, between, before, after), articles (a, an, the), or
       coordinating conjunctions (and, but, or, nor, so, yet).
     ✗ "End Of Play Sneakers" → WRONG ("Of" is a preposition, must be lowercase)
     ✗ "Shop For The Best Deals" → WRONG ("For" and "The" in middle position must be lowercase)
     ✓ "End-of-Play Sneakers" / "Shop for the Best Deals" → CORRECT
   · Descriptions must use standard sentence case (capitalize only the first word and proper nouns).
   · NEVER write any word entirely in ALL CAPS (e.g. FREE, SALE, NOW) — this is a policy violation.
   · ALL CAPS exception ONLY for natural acronyms ≤4 letters: USA, MXN, USD, EUR, VPN, AI, SEO, HQ, OEM, GPS, LED, USB, PDF, HTML, CSS, JS.
     ✗ "Renta Autos MX desde MXN499" → "MX" 2-letter + "MXN" both OK as acronyms, BUT keep total ALL-CAPS words ≤30% of headline.
9. UNFAIR ADVANTAGE — STRICTLY BANNED CLAIMS (Google Ads policy "unfair advantage"):
   · Headlines/descriptions must NOT include unverified superlatives or "free-cancellation-like" guarantees:
     ✗ Banned standalone (without provable evidence): "Trusted by Millions", "Award-Winning", "#1 in X",
       "Best in Class", "Guaranteed Results", "100% Effective", "Stops X Forever", "Never Fail",
       "World's Best", "Top-Rated", "Industry Leader", "Skip Other Apps", "Better than Competitors",
       "Beat Every Other", "Sick of Other X", "Tired of Bad X" (anti-competitor phrasing).
   · Allowed only if SAME wording appears verbatim on the merchant's own website AND it is a verifiable
     factual claim (e.g. an actual industry award, a real public review count).
     ✓ "Loved by 2,700+ Customers" (if site says "2,700+ verified buyers")
     ✗ "Award-Winning Goat Milk Brand" (unless site lists the specific award)
10. NUMERICAL CLAIMS — EVIDENCE REQUIRED:
    · Any number (price, percentage, year, count) you mention MUST be sourced from the website content
      provided above. Do NOT invent prices, discount %, "X+ customers", year founded, etc.
    · If you need a number but can't verify it from website content, drop the number entirely.
      ✗ "30% Off Sitewide" (if site shows no 30% promo today)
      ✗ "Trusted by 10,000 customers" (if site only shows reviews count = 2,792)
      ✓ "From $13.30" (if site clearly states "from $13.30")
11. INAPPROPRIATE CONTENT — BANNED LEXICON (Google Ads "shocking/scary/violent" policy):
    · NEVER use these words in headlines OR descriptions, even if the merchant sells Halloween/horror items:
      Spooky, Scary, Demon, Demonic, Blood, Bloody, Hacked, Hack, Kill, Dead, Death, Violence, Horror,
      Nightmare, Creepy, Sinister, Sick of, Pop-Ups, Threats, Attack, Malware, Virus, Infected.
    · For Halloween/costume/horror merchants, use NEUTRAL alternatives instead:
      ✗ "Spooky welcome for your front entrance" → ✓ "Themed decor for your front entrance"
      ✗ "Demon Hunters graphic t-shirt" → ✓ "Graphic Tees — Hunter Collection"
      ✗ "Spooky duo decor for your home" → ✓ "Themed decorative duo for your home"
12. PHONE NUMBERS — STRICTLY FORBIDDEN IN HEADLINES/DESCRIPTIONS:
    · Do NOT include any phone number in headlines or descriptions, regardless of format
      (US: 555-123-4567 or (555) 123-4567; international: +1 555 123 4567; toll-free: 1-800-XXX-XXXX).
    · Phone numbers belong in Call Extensions (separate ad component), NEVER in copy.
    · Even if the website prominently displays phone numbers, do NOT echo them in your output.
13. CATEGORY-SPECIFIC RULES (assess merchant category from website content):
    · ANTIVIRUS / SECURITY / VPN / Antimalware: NO absolute claims ("Stops All", "100% Clean",
      "Block Everything"), NO scare tactics ("Sick of Hacks?", "Phone Hacked?"), use functional
      descriptions instead ("Device Protection", "Privacy Tools", "Browse Safely").
    · HEALTH / SUPPLEMENTS / BEAUTY (skincare/cosmetics): NO medical claims ("Cures X", "Treats Y",
      "Heals Z") unless the merchant is a licensed medical provider. Use cosmetic-claim language
      ("Hydrates", "Nourishes", "Visible improvement"). NO "Doctor-Approved" without verifiable doctor.
    · GAMBLING / CASINO / SWEEPSTAKES: NO "Win Big", "Guaranteed Wins", "Easy Money" — use
      "Entertainment", "Play Responsibly" language only.
    · ADULT-ADJACENT (lingerie, sleepwear, swimwear): Use product-functional language only
      ("Loungewear", "Swimwear", "Intimate Apparel" instead of provocative descriptors).
${industryPromptHint}${discountGuidance}${shippingGuidance}

═══ MERCHANT INTELLIGENCE — READ ALL BEFORE WRITING ═══
- Merchant: ${merchantName}
- Website: ${merchantUrl}
- Target market: ${market.countryNameZh} (write in ${languageName})
- Budget: $${dailyBudget.toFixed(2)}/day, CPC $${maxCpc.toFixed(2)}, Strategy: ${biddingStrategy}
${businessSummaryBlock}${keywordsBlock}${priceRangeBlock}${productBlock}
Website content (extract specific collection names, materials, features, brand voice):
${cache.pageText.slice(0, 5000)}

${cache.features.length > 0 ? `Merchant features (REAL — use them as copy hooks):\n${cache.features.slice(0, 20).join("\n")}\n` : ""}${semrushBlock}
Return ONLY a JSON object with this exact structure (sitelinks are generated by a separate pipeline — DO NOT output sitelink fields here):
{
  "headlines": ["h1","h2",...],
  "descriptions": ["d1","d2","d3","d4"]
}

═══ COPYWRITING CRAFT ═══

Your job is NOT to describe the product. Your job is to make someone who wasn't sure if they wanted it suddenly NEED it.

Before writing EACH headline or description, ask:
  1. Would I stop scrolling if I saw this? (ATTENTION)
  2. Does this give a SPECIFIC reason to buy? (VALUE)
  3. Does this sound like a human, or a robot filling space? (SOUL)
  4. Could this headline work for ANY other brand? If yes → REWRITE. Every line must be ownable by this specific merchant.

DESIRE-BUILDING TOOLKIT:
  • PAINT THE AFTER: "Wake up to clear skin" > "Effective skincare solution"
  • NAME THE VILLAIN: "No more breakouts" > "Skincare products"
  • USE SENSORY WORDS: "buttery soft", "razor sharp", "whisper quiet", "featherlight"
  • SOCIAL PROOF WITH TEXTURE: "Loved by 12K+ customers who tried everything else first"
  • CONTRAST CREATES CLARITY: "No chemicals — just results" / "Not mass-produced. Handmade."
  • SPECIFICITY IS DESIRE: "3 patented ingredients" / "Handcrafted from Italian leather"

Power words (use freely): proven, real, fast, works, rated, top-selling, trusted, easy, clear, fresh, effective, lasting, gentle, visible, simple, loved, tested, natural, pure, handmade

BANNED words (auto-rejected): unlock, unleash, elevate, revolutionize, seamless, cutting-edge, game-changer, curated, empower, harness, innovative, transformative, holistic, paradigm, synergy

═══ HEADLINES — exactly 15, each ≤30 chars ═══

⚠️ CRITICAL DISTRIBUTION RULE: Only headline #1 may include "${merchantName}" as a prefix. Headlines #2–15 must NOT start with "${merchantName}". Vary the angle for every single headline — if two headlines feel similar, replace one.

Angle distribution (follow this):
  ① Brand anchor (headline #1 ONLY): "${merchantName}" + one specific hook. E.g. "${merchantName} — Built Since 1987" or "${merchantName} Denim, LA-Made"
  ② Keyword mirrors (#2–4, 3 headlines): Echo the confirmed search keywords — specific, searchable. Add ONE benefit hook to each, NOT just the keyword alone.
     ✗ "AG Jeans Denim & Clothing" (keyword + generic category = zero value)
     ✓ "AG Denim — Holds Shape All Day" (keyword + specific benefit)
  ③ Pain/desire hook (#5–6, 2 headlines): The exact emotional itch — name the problem users hate.
     ✓ "Stop Settling For Baggy Knees" / "Sick of Jeans That Lose Shape?"
  ④ Outcome visualization (#7–8, 2 headlines): Paint the after — what life looks like with this product.
     ✓ "From Office to Dinner — One Pair" / "Denim That Moves With You"
  ⑤ Trust/proof (#9–10, 2 headlines): Credibility that feels real, not claimed.
     ✓ "4.8★ by 12K+ Customers" / "Made in L.A. Since 1987"
  ⑥ Only-we-do-this (#11–12, 2 headlines): The thing competitors CAN'T say.
     ✓ "The Only Denim With Su-Per® Stretch" / "No-Sag Guarantee or Full Refund"
  ⑦ CTA with reason (#13–15, 3 headlines): Action + specific incentive — not just "Shop Now".
     ✗ "Shop Spring Collection Now" (no reason to act NOW)
     ✗ "Use The Women's Fit Guide" (no desire, no hook)
     ✓ "Find Your Perfect Fit — Free Returns" / "Try Risk-Free for 30 Days"
  ${hasRealDiscount ? "  ⑧ Discount: reference the verified discount in one of the CTA headlines — be specific" : ""}
  ${hasRealFreeShipping ? "  ⑧ Free Shipping: weave into one CTA headline as a value hook" : ""}

Rules:
- Use Title Case or sentence case — NEVER ALL CAPS
- No dates, expiry, or countdowns
- No multiple punctuation — at most ONE ! or ? per headline
- Front-load the most important word — readers scan left-to-right

═══ DESCRIPTIONS — exactly 4, each 50-90 chars ═══
Each description is a micro-sales-pitch. The reader is on the fence — your 90 characters push them over.
Each of the 4 descriptions must tackle a DIFFERENT psychological angle. They are NOT variations of the same message.

  Desc 1 — EMPATHY CLOSE: Start with their frustration, pivot to your solution in one breath.
     ✓ "Sick of jeans that sag? Try AG denim made in L.A. Shop the fit."
     ✗ "We offer a range of denim solutions for various needs." (about YOU, not THEM)

  Desc 2 — IRRESISTIBLE OFFER: Stack value until saying no feels like losing something.
     ✓ "Free shipping + free returns. Shop best-selling fits now."
     ✗ "Visit our website to browse our products." (zero value)

  Desc 3 — TRUST BUILDER: Remove every reason NOT to buy.
     ✓ "Rated 4.8★ by 50K+ customers. 30-day money-back guarantee."
     ✗ "We pride ourselves on customer satisfaction." (empty claim)

  Desc 4 — COMPETITIVE WEDGE: One sentence that makes alternatives feel inferior.
     ✓ "The only denim with Su-Per® stretch tech. No knockoffs. No compromise."
     ✗ "Our products are of the highest quality." (says nothing specific)

Rules:
- Each description MUST open with a different word/phrase — no two can start the same
- ${hasRealDiscount && hasRealFreeShipping ? "Description 1 or 2 may combine verified discount + free shipping" : "Only use verified information from the website content"}
- No multiple punctuation — at most one ! per description
- NEVER write in ALL CAPS
- Must be clearly distinct from headlines (Google penalizes repetition)

${isNonEnglish ? `\n⚠️ FINAL REMINDER: ALL headlines and descriptions MUST be in ${languageName}. The examples above are English templates for structure reference only — you MUST write the actual output in ${languageName}. Do NOT output any English text.\n` : ""}Return ONLY valid JSON, no explanation.`;

  try {
    const raw = await callAiWithFallback("ad_copy", [
      { role: "system", content: systemPrompt },
      { role: "user", content: prompt },
    ], 4096);
    const parsed = JSON.parse(extractJsonFromAi(raw));

    // ⑤+③ 把 headlines / descriptions 两条独立 pipeline 改并行（之前是串行 11-15s，
    //      并行后等于较慢那条的耗时，节省约 50%。两条 pipeline 无交叉依赖。）
    const processHeadlines = async () => {
      let rawHeadlines = Array.isArray(parsed.headlines)
        ? parsed.headlines.filter((h: string) => h && h.trim())
        : [];
      rawHeadlines = humanizeAdCopyBatch(rawHeadlines, 2, 30);
      rawHeadlines = await condenseOverlong(rawHeadlines, 30, languageName);
      let headlines = rawHeadlines.filter((h: string) => h.length >= 2 && h.length <= 30).slice(0, 15);

      if (headlines.length < 15) {
        console.log(`[Core] 标题 ${headlines.length}/15 不足，AI 返工补充`);
        headlines = await retryMissingHeadlines(headlines, 15, merchantName, languageName);
      }

      const headlineFix = await complianceAutoFix(headlines, "headline", merchantName, languageName, aiRuleProfile, 30, 2);
      headlines = headlineFix.items;

      if (headlines.length < 15) {
        console.log(`[Core] 合规删除后标题 ${headlines.length}/15，AI 再次返工`);
        const patched = await retryMissingHeadlines(headlines, 15, merchantName, languageName);
        const cleanNew = patched.filter((h: string) => !headlines.includes(h) && checkItemViolations([h], aiRuleProfile).length === 0);
        headlines = [...headlines, ...cleanNew].slice(0, 15);
        console.log(`[Core] 合规后返工补充: +${cleanNew.length} 条 (总${headlines.length})`);
      }
      send("headlines", headlines);
      return { items: headlines, fix: headlineFix };
    };

    const processDescriptions = async () => {
      let rawDescs = Array.isArray(parsed.descriptions)
        ? parsed.descriptions.filter((d: string) => d && d.trim())
        : [];
      rawDescs = humanizeAdCopyBatch(rawDescs, 40, 90);
      rawDescs = await condenseOverlong(rawDescs, 90, languageName);
      let descriptions = rawDescs.filter((d: string) => d.length >= 40 && d.length <= 90).slice(0, 4);

      if (descriptions.length < 4) {
        console.log(`[Core] 描述 ${descriptions.length}/4 不足，AI 返工补充`);
        descriptions = await retryMissingDescriptions(descriptions, 4, merchantName, languageName);
      }

      const descFix = await complianceAutoFix(descriptions, "description", merchantName, languageName, aiRuleProfile, 90, 40);
      descriptions = descFix.items;

      if (descriptions.length < 4) {
        console.log(`[Core] 合规删除后描述 ${descriptions.length}/4，AI 再次返工`);
        const patched = await retryMissingDescriptions(descriptions, 4, merchantName, languageName);
        const cleanNew = patched.filter((d: string) => !descriptions.includes(d) && checkItemViolations([d], aiRuleProfile).length === 0);
        descriptions = [...descriptions, ...cleanNew].slice(0, 4);
        console.log(`[Core] 合规后返工补充描述: +${cleanNew.length} 条 (总${descriptions.length})`);
      }
      send("descriptions", descriptions);
      return { items: descriptions, fix: descFix };
    };

    const [hlResult, descResult] = await Promise.all([processHeadlines(), processDescriptions()]);
    let headlines = hlResult.items;

    // ═════════════════════════════════════════════════════════════════
    // C-082 Part D (RC-4)：主题一致性后置校验 + 按品类重写 retry
    //   防御 AI 即使有 pageText/keywords/category 仍被品牌名 prior 拉偏到错误品类
    //   （Yoin BE 真实业务=手机套餐，但 AI 写出服装文案的事故）。
    //   失败保守处理（假设对齐），不阻塞主流程；触发重写时只调一次。
    // ═════════════════════════════════════════════════════════════════
    try {
      const alignmentKeywords = (confirmedKeywords.length > 0 ? confirmedKeywords : dbKeywordsForFallback)
        .map((k) => k.trim())
        .filter(Boolean)
        .slice(0, 10);
      const verdict = await verifyHeadlinesAlignment(
        headlines,
        cache.pageText,
        merchantCategory,
        alignmentKeywords,
        businessSummary,
        merchantName,
      );
      console.warn(
        `[Core] 主题对齐校验：aligned=${verdict.aligned} expected="${verdict.expectedCategory}" detected="${verdict.detectedCategory}" drift="${verdict.driftReason}"`,
      );
      if (!verdict.aligned && verdict.expectedCategory && verdict.expectedCategory.length >= 3) {
        console.warn(
          `[Core] 主题漂移命中，触发按品类重写: "${verdict.detectedCategory}" → "${verdict.expectedCategory}"`,
        );
        const rewritten = await rewriteHeadlinesForCategory(
          headlines,
          verdict.expectedCategory,
          verdict.detectedCategory || "the wrong category",
          merchantName,
          cache.pageText,
          alignmentKeywords,
          languageName,
          15,
        );
        if (rewritten !== headlines && rewritten.length >= 8) {
          headlines = rewritten;
          send("headlines", headlines);
          send("alignment_rewrite", {
            expected: verdict.expectedCategory,
            detected: verdict.detectedCategory,
            count: rewritten.length,
          });
          console.warn(`[Core] 按品类重写完成，新 headlines=${rewritten.length} 条`);
        } else {
          console.warn("[Core] 按品类重写未达数量阈值，保留原 headlines");
        }
      }
    } catch (alignErr) {
      console.warn("[Core] 主题对齐校验异常（不阻断）:", alignErr instanceof Error ? alignErr.message : alignErr);
    }

    let descriptions = descResult.items;
    const headlineFix = hlResult.fix;
    const descFix = descResult.fix;

    // 汇总合规修复结果
    const allAutoFixed = [...headlineFix.fixed, ...descFix.fixed];
    const allRemaining = [...headlineFix.remaining, ...descFix.remaining];
    if (allAutoFixed.length > 0) {
      send("compliance_auto_fix", { fixed: allAutoFixed, count: allAutoFixed.length });
      console.log(`[Core] 合规自动修复: ${allAutoFixed.length} 条已替换`);
    }
    if (allRemaining.length > 0) {
      send("compliance_warnings", { warnings: allRemaining, count: allRemaining.length });
      console.log(`[Core] 合规警告: ${allRemaining.length} 条仍有风险（已达最大重试次数）`);
    }

    // ═════════════════════════════════════════════════════════════════
    // C-016: Google Ads 官方政策闸 + 事实证据闸（软闸，违规条目走单条 mini-retry）
    //   - collectGooglePolicyViolations: 绝对化/无证据承诺/夸大/禁用符号/国家标签泄漏/DKI
    //   - validateClaims: 百分比/货币/电话/年限/免运/保修 对 rawMentions/promoRegex/features/phone
    //   - rewriteViolationsOnly: 最多 3 轮 AI 单条重写，失败 → safe-ad-template 兜底
    // ═════════════════════════════════════════════════════════════════
    try {
      const { collectGooglePolicyViolations } = await import("@/lib/ai-rule-profile");
      const { validateClaims } = await import("@/lib/claim-validator");
      const { rewriteViolationsOnly } = await import("@/lib/ai-retry-loop");
      // D-039 H3：本地合规校验器（不公平优势 / 不当内容 / 电话号码 / 大写 / 品牌名泄漏 / 行业感知）
      const { checkAdCompliance } = await import("@/lib/ad-compliance-checker");

      const evidence = {
        rawMentions: cache.rawMentions,
        promoRegex: cache.promoRegex,
        phone: cache.phoneCandidates && cache.phoneCandidates.length > 0 ? cache.phoneCandidates[0] : null,
        features: cache.features,
      };

      const buildHintMap = (items: string[], field: "headline" | "description") => {
        const gv = collectGooglePolicyViolations(
          field === "headline"
            ? { headlines: items, brandRoot: merchantName }
            : { descriptions: items, brandRoot: merchantName }
        ).filter((v) => v.field === field);
        const cv = validateClaims({
          texts: items.map((t, i) => ({ field, index: i, text: t })),
          evidence,
          country,
        });
        // D-039 H3：补充行业感知 + 不公平优势 + 不当内容 + 电话号码违规
        const h3Result = checkAdCompliance(
          field === "headline" ? items : [],
          field === "description" ? items : [],
          { industryProfile, merchantName },
        );
        const h3Critical = h3Result.violations.filter((v) => v.field === field && v.severity === "critical");

        const map = new Map<number, string[]>();
        for (const v of gv) {
          if (!map.has(v.index)) map.set(v.index, []);
          map.get(v.index)!.push(v.hint);
        }
        for (const u of cv.unsupported) {
          if (!map.has(u.index)) map.set(u.index, []);
          map.get(u.index)!.push(u.hint);
        }
        for (const h of h3Critical) {
          if (!map.has(h.index)) map.set(h.index, []);
          map.get(h.index)!.push(`[D-039:${h.rule}] ${h.hint}`);
        }
        return [...map.entries()].map(([index, hints]) => ({ index, hint: hints.join(" | ") }));
      };

      const validateAfter = (text: string, field: "headline" | "description"): boolean => {
        const gv = collectGooglePolicyViolations(
          field === "headline"
            ? { headlines: [text], brandRoot: merchantName }
            : { descriptions: [text], brandRoot: merchantName }
        );
        if (gv.length > 0) return false;
        const cv = validateClaims({
          texts: [{ field, index: 0, text }],
          evidence,
          country,
        });
        if (!cv.ok) return false;
        // D-039 H3：行业感知 + 字词级违规也要过
        const h3 = checkAdCompliance(
          field === "headline" ? [text] : [],
          field === "description" ? [text] : [],
          { industryProfile, merchantName },
        );
        return h3.criticalCount === 0;
      };

      // ⑤+③ 政策闸 headlines / descriptions 改并行（两者独立，原串行 6-20s → 并行约一半）
      const runGateFor = async (field: "headline" | "description", items: string[]) => {
        const hints = buildHintMap(items, field);
        if (hints.length === 0) return null;
        console.warn(`[Core] C-016 ${field} 政策/证据违规 ${hints.length} 条，触发单条 mini-retry`);
        const result = await rewriteViolationsOnly({
          items,
          violations: hints,
          opts: {
            field,
            brandRoot: merchantName,
            country,
            languageCode: adLanguageCode || market.languageCode,
            languageName,
            maxLen: field === "headline" ? 30 : 90,
            minLen: field === "headline" ? 2 : 40,
            maxRounds: 3,
          },
          validateAfterFn: (text) => validateAfter(text, field),
        });
        return result;
      };

      const [hlGate, dlGate] = await Promise.all([
        runGateFor("headline", headlines),
        runGateFor("description", descriptions),
      ]);

      if (hlGate) {
        headlines = hlGate.items;
        send("headlines", headlines);
        if (hlGate.rewritten.length > 0 || hlGate.degraded.length > 0) {
          send("compliance_policy_fix", {
            field: "headline",
            rewritten: hlGate.rewritten.length,
            degraded: hlGate.degraded.length,
          });
          console.warn(`[Core] headlines 政策重写：成功 ${hlGate.rewritten.length}，兜底 ${hlGate.degraded.length}`);
        }
      }
      if (dlGate) {
        descriptions = dlGate.items;
        send("descriptions", descriptions);
        if (dlGate.rewritten.length > 0 || dlGate.degraded.length > 0) {
          send("compliance_policy_fix", {
            field: "description",
            rewritten: dlGate.rewritten.length,
            degraded: dlGate.degraded.length,
          });
          console.warn(`[Core] descriptions 政策重写：成功 ${dlGate.rewritten.length}，兜底 ${dlGate.degraded.length}`);
        }
      }
    } catch (gateErr) {
      console.warn("[Core] C-016 政策/证据闸异常（不阻断）:", gateErr instanceof Error ? gateErr.message : gateErr);
    }

    // C-016: sitelinks 已由独立 pipeline 产出（见 generateCore 顶部 sitelinkPipeline）。
    // 此处只持久化 headlines / descriptions / display_path，sitelinks 由 pipeline 自行写入 DB。
    if (adCreativeId) {
      const pathSuggest = suggestDisplayPaths(merchantName, [], country);
      await prisma.ad_creatives.update({
        where: { id: adCreativeId },
        data: {
          headlines: headlines as any,
          descriptions: descriptions as any,
          display_path1: pathSuggest.path1,
          display_path2: pathSuggest.path2,
        },
      });
    }

    console.log(`[Core] AI 主流完成: ${headlines.length} 标题, ${descriptions.length} 描述（sitelinks 走独立 pipeline）`);
  } catch (err) {
    console.error("[Core] AI 生成失败:", err instanceof Error ? err.message : err);
    // fallback: 使用 padHeadlines/padDescriptions
    // D-025 R-1.A：fallback 路径必须把已抓到的商家上下文全部传下去，避免 AI 在零信号下
    //                跟着 7-ANGLE FRAMEWORK 的范例方向乱写（详见 §四·D-025 §4.2 RC-1）
    try {
      const { padHeadlines, padDescriptions } = await import("@/lib/ai-service");
      // C-082 Part A (RC-2)：fallback 路径必须传 keywords — D-025 只补了被动信息（pageText/summary/features/category），
      // 漏修了"主动方向标"keywords。本案例 Yoin BE 5 条手机套餐关键词正等着用，但 fallback 完全没传 → AI 失去强约束。
      // 优先级：confirmedKeywords（员工已确认）> dbKeywordsForFallback（DB 兜底）。
      const fallbackKeywords = (confirmedKeywords.length > 0 ? confirmedKeywords : dbKeywordsForFallback)
        .map((k) => k.trim())
        .filter(Boolean)
        .slice(0, 10);
      console.warn(
        `[Core] fallback 启动: confirmedKeywords=${confirmedKeywords.length} dbKeywords=${dbKeywordsForFallback.length} effective=${fallbackKeywords.length} → padHeadlines`,
      );
      const sharedBusinessContext = {
        pageText: cache.pageText,
        merchantUrl,
        category: merchantCategory ?? undefined,
        businessSummary: businessSummary?.summary_en ?? null,
        businessCategoryGuess: businessSummary?.category_guess ?? null,
        features: cache.features,
        crawledProducts: cache.crawledProducts,
      } as const;
      let headlines = await padHeadlines([], merchantName, country, 15, {
        referenceItems: cache.semrushTitles,
        keywords: fallbackKeywords,
        dailyBudget: Number(adSettings?.daily_budget || 2),
        maxCpc: Number(adSettings?.max_cpc || 0.3),
        biddingStrategy: adSettings?.bidding_strategy || "MAXIMIZE_CLICKS",
        aiRuleProfile,
        adLanguageCode,
        ...sharedBusinessContext,
      });
      send("headlines", headlines);
      const descriptions = await padDescriptions([], merchantName, country, 4, {
        referenceItems: cache.semrushDescriptions,
        keywords: fallbackKeywords,
        dailyBudget: Number(adSettings?.daily_budget || 2),
        maxCpc: Number(adSettings?.max_cpc || 0.3),
        biddingStrategy: adSettings?.bidding_strategy || "MAXIMIZE_CLICKS",
        aiRuleProfile,
        adLanguageCode,
        ...sharedBusinessContext,
      });
      send("descriptions", descriptions);

      // C-082 Part D (RC-4)：fallback 路径同样做主题对齐校验 + 按品类重写 retry。
      // Yoin BE 事故现场的真实路径就是 fallback，必须在此兜底。
      try {
        const verdictFb = await verifyHeadlinesAlignment(
          headlines,
          cache.pageText,
          merchantCategory,
          fallbackKeywords,
          businessSummary,
          merchantName,
        );
        console.warn(
          `[Core] fallback 主题对齐校验：aligned=${verdictFb.aligned} expected="${verdictFb.expectedCategory}" detected="${verdictFb.detectedCategory}" drift="${verdictFb.driftReason}"`,
        );
        if (!verdictFb.aligned && verdictFb.expectedCategory && verdictFb.expectedCategory.length >= 3) {
          console.warn(
            `[Core] fallback 主题漂移命中，触发按品类重写: "${verdictFb.detectedCategory}" → "${verdictFb.expectedCategory}"`,
          );
          const rewritten = await rewriteHeadlinesForCategory(
            headlines,
            verdictFb.expectedCategory,
            verdictFb.detectedCategory || "the wrong category",
            merchantName,
            cache.pageText,
            fallbackKeywords,
            languageName,
            15,
          );
          if (rewritten !== headlines && rewritten.length >= 8) {
            headlines = rewritten;
            send("headlines", headlines);
            send("alignment_rewrite", {
              expected: verdictFb.expectedCategory,
              detected: verdictFb.detectedCategory,
              count: rewritten.length,
            });
            console.warn(`[Core] fallback 按品类重写完成，新 headlines=${rewritten.length} 条`);
          }
        }
      } catch (alignErr) {
        console.warn("[Core] fallback 主题对齐校验异常（不阻断）:", alignErr instanceof Error ? alignErr.message : alignErr);
      }

      // C-016: sitelinks 由独立 pipeline 负责（不在 fallback 分支重复生成）
      if (adCreativeId) {
        const pathSuggest2 = suggestDisplayPaths(merchantName, [], country);
        await prisma.ad_creatives.update({
          where: { id: adCreativeId },
          data: { headlines: headlines as any, descriptions: descriptions as any, display_path1: pathSuggest2.path1, display_path2: pathSuggest2.path2 },
        });
      }
    } catch (fallbackErr) {
      console.error("[Core] Fallback 也失败:", fallbackErr);
      send("headlines", []); send("descriptions", []);
    }
  }

  // C-016: 等独立 sitelink pipeline 完成（确保 SSE 在 stream 关闭前推送完 sitelinks）
  await sitelinkPipeline.catch((e) => {
    console.warn("[Core] await sitelinkPipeline 异常:", e instanceof Error ? e.message : e);
  });
}

/**
 * C-017: "重新爬取"按钮专用分支。
 *   - 只跑 discover + autoExpandSitelinks + sitelink AI writer
 *   - 复用已重爬的 cache.sitelinkCandidates
 *   - 回写 ad_creatives.sitelinks，同步推 SSE sitelinks 事件
 * 不跑 headlines / descriptions / images，避免用户点"重新爬取"时误触其它字段。
 */
async function generateSitelinksOnly(
  cache: CrawlCache,
  merchantName: string,
  merchantUrl: string,
  country: string,
  adCreativeId: bigint | null,
  send: (type: string, data: unknown) => void,
  adLanguageCode?: string,
): Promise<void> {
  try {
    const market = getAdMarketConfig(country);

    const baseline = (cache.sitelinkCandidates || []).map((s) => ({
      url: s.url,
      title: s.title,
      description: s.description,
    }));
    const expanded = await autoExpandSitelinks({
      merchantUrl,
      country,
      existing: baseline,
      targetCount: 6,
    });

    const unique: typeof expanded = [];
    const seen = new Set<string>();
    for (const s of expanded) {
      const norm = s.url.replace(/\/$/, "").replace(/^http:/, "https:").toLowerCase();
      if (seen.has(norm)) continue;
      seen.add(norm);
      unique.push(s);
      if (unique.length >= 8) break;
    }

    if (unique.length === 0) {
      console.warn(`[SitelinksOnly] 无候选，推空 sitelinks`);
      send("sitelinks", []);
      if (adCreativeId) {
        await prisma.ad_creatives
          .update({ where: { id: adCreativeId }, data: { sitelinks: [] as any } })
          .catch((e) => console.warn("[SitelinksOnly] 清空 sitelinks 失败:", e instanceof Error ? e.message : e));
      }
      return;
    }

    const aiInputs = unique.map((s) => ({
      url: s.url,
      pageTitle: s.title,
      pageDescription: s.description,
    }));
    const written = await generateSitelinkTexts(aiInputs, {
      brandRoot: merchantName,
      country,
      languageCode: adLanguageCode || market.languageCode,
    });
    const final = written.slice(0, 6);

    send("sitelinks", final);
    if (adCreativeId) {
      await prisma.ad_creatives
        .update({ where: { id: adCreativeId }, data: { sitelinks: final as any } })
        .catch((e) => console.warn("[SitelinksOnly] 持久化失败:", e instanceof Error ? e.message : e));
    }
    console.warn(
      `[SitelinksOnly] discover=${baseline.length} expanded=${expanded.length} ai_written=${written.length} final=${final.length}`,
    );
  } catch (e) {
    console.error("[SitelinksOnly] 异常（推空）:", e instanceof Error ? e.message : e);
    send("sitelinks", []);
  }
}

// Google Ads 审批的 Promotion occasion 枚举
const GOOGLE_PROMOTION_OCCASIONS = [
  "BACK_TO_SCHOOL", "BLACK_FRIDAY", "CHRISTMAS", "CYBER_MONDAY",
  "EASTER", "FATHERS_DAY", "HALLOWEEN", "MOTHERS_DAY",
  "NEW_YEARS", "THANKSGIVING", "VALENTINES_DAY", "NONE",
] as const;
type PromotionOccasion = (typeof GOOGLE_PROMOTION_OCCASIONS)[number];

// Google Ads 审批的 Structured Snippet header 枚举（13个）
const GOOGLE_SNIPPET_HEADERS = [
  "Amenities", "Brands", "Courses", "Degree programs", "Destinations",
  "Featured hotels", "Insurance coverage", "Models", "Neighborhoods",
  "Service catalog", "Shows", "Styles", "Types",
] as const;
type SnippetHeader = (typeof GOOGLE_SNIPPET_HEADERS)[number];

function validatePromotionOccasion(val: string): PromotionOccasion {
  const upper = val.toUpperCase().replace(/ /g, "_") as PromotionOccasion;
  return GOOGLE_PROMOTION_OCCASIONS.includes(upper) ? upper : "NONE";
}

function validateSnippetHeader(val: string): SnippetHeader {
  const found = GOOGLE_SNIPPET_HEADERS.find(
    (h) => h.toLowerCase() === val.toLowerCase()
  );
  return found ?? "Types";
}


// ─── 可选扩展批量生成 ───

async function generateOptionalBatch(
  cache: CrawlCache,
  merchantName: string,
  merchantUrl: string,
  country: string,
  optionalTypes: string[],
  aiRuleProfile: unknown,
  send: (type: string, data: unknown) => void,
  adLanguageCode?: string,
) {
  if (optionalTypes.length === 0) return;

  const market = getAdMarketConfig(country);
  const languageName = resolveLanguageName(country, adLanguageCode);

  // ─── call: 只使用真实爬取的电话，找不到则 skipped ───
  if (optionalTypes.includes("call")) {
    try {
      const phone = await extractPhoneFromCache(cache, merchantUrl, country);
      if (phone) {
        send("call", { found: true, skipped: false, ...phone });
      } else {
        send("call", { skipped: true });
        console.log("[Optional] 致电扩展：未找到真实电话，跳过");
      }
    } catch {
      send("call", { skipped: true });
    }
  }

  // ─── promotion: 三层流水线 —— regex结构化数据 → rawMentions AI解析 → 数字一致性校验 ───
  if (optionalTypes.includes("promotion")) {
    const promo = cache.promoRegex as Record<string, unknown> | null;
    const discountPercent = promo?.discount_percent ? Number(promo.discount_percent) : 0;
    const discountAmount = promo?.discount_amount ? Number(promo.discount_amount) : 0;
    const hasRealDiscount = discountPercent > 0 || discountAmount > 0;

    // 辅助：去除 target 中的折扣数字文本
    const stripDiscountFromTarget = (text: string) =>
      text
        .replace(/,?\s*up\s+to\s+\d+\s*%\s*off/gi, "")
        .replace(/,?\s*\d+\s*%\s*off/gi, "")
        .replace(/,?\s*\$[\d,.]+\s*off/gi, "")
        .replace(/,?\s*save\s+\d+%/gi, "")
        .replace(/\s{2,}/g, " ")
        .trim();

    /**
     * verifyPromoResult: 校验 AI 生成的折扣数值是否确实出现在原文 rawMentions.promo 中。
     * 若校验失败，返回 false（需要跳过或重试）。
     */
    const verifyPromoResult = (
      aiPercent: number,
      aiAmount: number,
      sources: string[],
    ): boolean => {
      if (sources.length === 0) return true; // 无原文时不校验，放行
      const combined = sources.join(" ").toLowerCase();
      if (aiPercent > 0) {
        // 原文中必须有这个百分比数字
        return new RegExp(`\\b${aiPercent}\\s*%`).test(combined);
      }
      if (aiAmount > 0) {
        // 原文中必须有这个金额数字（含货币符号或数字）
        return new RegExp(`\\b${aiAmount}\\b`).test(combined);
      }
      return true;
    };

    // 层 1：regex 结构化结果已有真实折扣
    if (hasRealDiscount && promo) {
      const occasion = validatePromotionOccasion(String(promo.occasion || "NONE"));
      const rawTarget = String(promo.promotion_target || "").trim();
      const cleanedTarget = stripDiscountFromTarget(rawTarget);
      let promotionTarget = cleanedTarget.slice(0, 20);

      if (cleanedTarget.length > 20) {
        try {
          const aiRaw = await callAiWithFallback("extension", [
            {
              role: "user",
              content: `You are a Google Ads copywriter. Extract ONLY the promotion event name from the text below.\n\nRules:\n- Max 20 characters (including spaces)\n- Output ONLY the event name (e.g. "Friends & Family", "Spring Specials", "Summer Sale")\n- Do NOT include any discount numbers, percentages, or "off"\n- No punctuation at the end\n- English only\n\nText: "${cleanedTarget}"`,
            },
          ], 30);
          const optimized = aiRaw.trim().replace(/^["']|["']$/g, "").slice(0, 20);
          if (optimized.length >= 3) promotionTarget = optimized;
        } catch (e) {
          console.warn(`[Optional] 促销标题 AI 优化失败:`, e instanceof Error ? e.message : e);
        }
      }

      send("promotion", {
        skipped: false,
        found: true,
        promotion_target: promotionTarget,
        discount_type: String(promo.discount_type || "PERCENT"),
        discount_percent: discountPercent > 0 ? discountPercent : null,
        discount_amount: discountAmount > 0 ? discountAmount : null,
        currency_code: market.currencyCode,
        occasion,
        final_url: merchantUrl,
      });
      console.log(`[Optional] 促销扩展[层1-regex]：${discountPercent > 0 ? discountPercent + "%" : "$" + discountAmount}，target="${promotionTarget}"`);
    }
    // 层 2：regex 无结果，但 rawMentions.promo 有原文 → 交给 AI 解析
    else {
      const promoSnippets = cache.rawMentions?.promo;

      if (!promoSnippets || promoSnippets.length === 0) {
        send("promotion", { skipped: true });
        console.log(`[Optional] 促销扩展：regex无折扣且无 rawMentions，跳过`);
      } else {
        console.log(`[Optional] 促销扩展[层2-AI]：rawMentions.promo=${promoSnippets.length} 条，发送 AI 解析`);
        const snippetsText = promoSnippets.slice(0, 8).map((s, i) => `${i + 1}. "${s}"`).join("\n");

        const aiPrompt = `You are a Google Ads promotion data extractor. Read the following REAL snippets from the merchant's website and extract the promotion details.

Snippets from website:
${snippetsText}

Return ONLY a JSON object (no markdown, no explanation):
{
  "discount_type": "PERCENT" | "MONETARY" | "NONE",
  "discount_percent": <number or null>,
  "discount_amount": <number or null>,
  "promotion_target": "<max 20 chars, event name only, e.g. First Order, Newsletter, Summer Sale>",
  "found": <true if a real discount exists, false otherwise>
}

Rules:
- ONLY extract numbers that EXPLICITLY appear in the snippets above. NEVER invent numbers.
- discount_type "PERCENT" requires a "%" sign in the snippets.
- discount_type "MONETARY" requires a "$"/"€"/"£" amount in the snippets.
- promotion_target must be the event/occasion name without discount numbers (max 20 chars).
- If no real discount is found, set found: false.`;

        let aiPromo: { discount_type: string; discount_percent: number | null; discount_amount: number | null; promotion_target: string; found: boolean } | null = null;
        let retries = 2;
        while (retries-- > 0 && !aiPromo) {
          try {
            const aiRaw = await callAiWithFallback("extension", [{ role: "user", content: aiPrompt }], 256);
            const parsed = JSON.parse(extractJsonFromAi(aiRaw)) as Record<string, unknown>;
            if (parsed && (parsed.found === true || parsed.found === "true")) {
              const pct = parsed.discount_percent ? Number(parsed.discount_percent) : 0;
              const amt = parsed.discount_amount ? Number(parsed.discount_amount) : 0;
              if (pct > 0 || amt > 0) {
                // 层 3：数字一致性校验 —— AI 输出的数字必须在原文中真实存在
                const verified = verifyPromoResult(pct, amt, promoSnippets);
                if (verified) {
                  aiPromo = { ...parsed, discount_percent: pct || null, discount_amount: amt || null };
                  console.log(`[Optional] 促销扩展[层3-验证通过]：pct=${pct}, amt=${amt}, target="${parsed.promotion_target}"`);
                } else {
                  console.warn(`[Optional] 促销扩展[层3-验证失败]：AI 输出 pct=${pct}/amt=${amt} 在原文中未找到，重试(${retries})`);
                  aiPromo = null;
                }
              }
            }
          } catch (e) {
            console.warn(`[Optional] 促销 AI 解析失败:`, e instanceof Error ? e.message : e);
          }
        }

        if (aiPromo) {
          const occasion = validatePromotionOccasion("NONE");
          const promotionTarget = stripDiscountFromTarget(String(aiPromo.promotion_target || "")).slice(0, 20) || "Special Offer";
          send("promotion", {
            skipped: false,
            found: true,
            promotion_target: promotionTarget,
            discount_type: aiPromo.discount_type || "PERCENT",
            discount_percent: aiPromo.discount_percent,
            discount_amount: aiPromo.discount_amount,
            currency_code: market.currencyCode,
            occasion,
            final_url: merchantUrl,
          });
          console.log(`[Optional] 促销扩展[层2+3]：输出 target="${promotionTarget}"，pct=${aiPromo.discount_percent}`);
        } else {
          send("promotion", { skipped: true });
          console.log(`[Optional] 促销扩展：AI 解析后数字校验均未通过，跳过`);
        }
      }
    }
  }

  // ─── price: 只使用真实爬取的价格数据，无数据则 skipped ───
  if (optionalTypes.includes("price")) {
    const crawledProducts = (cache as any).crawledProducts || [];
    let items: { header: string; description: string; price: number; currency: string; url: string }[] = [];

    // 将相对路径 URL 转为绝对 URL
    const toAbsoluteUrl = (url: string) => {
      if (!url) return merchantUrl;
      if (url.startsWith("http://") || url.startsWith("https://")) return url;
      try {
        const base = merchantUrl.startsWith("http") ? merchantUrl : `https://${merchantUrl}`;
        return new URL(url, base).toString();
      } catch { return merchantUrl; }
    };

    if (crawledProducts.length > 0) {
      items = crawledProducts
        .filter((p: any) => p.name && p.price && p.price > 0)
        .slice(0, 8)
        .map((p: any) => ({
          header: String(p.name).trim(),
          description: String(p.description || "").trim(),
          price: Number(p.price),
          currency: String(p.currency || market.currencyCode),
          url: toAbsoluteUrl(String(p.url || "")),
        }));
    }

    if (items.length === 0 && cache.priceRegex.length > 0) {
      items = cache.priceRegex.map((p) => ({ ...p, url: toAbsoluteUrl(p.url || "") }));
    }

    // 尝试子页面补充（仅真实数据）
    if (items.length === 0) {
      const subData = await fetchSubPagesForOptional(cache.links, ["price"]);
      if (subData.priceItems.length > 0) {
        items = subData.priceItems.map((p) => ({ ...p, url: toAbsoluteUrl(p.url || "") }));
      }
    }

    if (items.length === 0) {
      send("price_items", { skipped: true });
      console.log("[Optional] 价格扩展：未爬取到真实价格数据，跳过");
    } else {
      // ── AI 批量重写价格项的 header + description，和广告文案同等品质 ──

      const MAX_PRICE_RETRIES = 2;

      try {
        const priceRewritePrompt = `You are Adrian — a Google Ads price extension copywriter. Rewrite each product's title and description to be compelling, human, and benefit-driven.

Merchant: ${merchantName}
Language: ${languageName}

RAW PRODUCTS (from website crawl — these are real products with real prices):
${items.map((item, i) => `${i + 1}. Name: "${item.header}"${item.description ? ` | Desc: "${item.description}"` : ""} | ${item.currency} ${item.price}`).join("\n")}

YOUR TASK — rewrite each product into a Google Ads Price Extension entry:

HEADER (≤25 chars):
- Clean, appealing product name — NOT the raw crawl text
- Fix awkward numbering, spacing, capitalization (e.g. "Diaper rash cream 1 2 3" → "123 Diaper Rash Cream")
- Use Title Case naturally — "Gentle Cleansing Gel" not "2 in 1 cleansing gel"
- Keep brand-specific product names if they're already good
- Do NOT include prices or currency symbols
- Must sound like a product you'd see in a store, not a database entry

DESCRIPTION (≤25 chars):
- A benefit hook or what-it-does phrase — NOT a restatement of the header
- MUST be COMPLETELY DIFFERENT from the header — Google Ads rejects identical header/description
- Think: what would make a parent/buyer click? "Soothes baby's skin fast" not "Diaper rash cream"
- Use sensory/emotional language: "gentle", "soothing", "nourishing", "refreshing"
- Examples of GOOD descriptions: "Gentle daily face wash", "Soothes irritated skin", "Hydrates & protects", "Fresh scent all day"
- Examples of BAD descriptions: same as header, generic "Shop now", just a category name

Return ONLY a JSON array of objects:
[{"header": "...", "description": "..."}, ...]

Every header MUST be ≤25 characters. Every description MUST be ≤25 characters.
Header and description MUST be different for each item. COUNT CAREFULLY.`;

        let rewritten: { header: string; description: string }[] | null = null;

        for (let attempt = 1; attempt <= MAX_PRICE_RETRIES; attempt++) {
          try {
            const raw = await callAiWithFallback("ad_copy", [{ role: "user", content: priceRewritePrompt }], 2048);
            const parsed = JSON.parse(extractJsonFromAi(raw));
            if (Array.isArray(parsed) && parsed.length >= items.length) {
              rewritten = parsed.slice(0, items.length);
              break;
            }
            console.warn(`[Price] AI batch rewrite attempt ${attempt}: 返回数量不匹配 (${parsed?.length} vs ${items.length})`);
          } catch (e) {
            console.warn(`[Price] AI batch rewrite attempt ${attempt} 失败:`, e instanceof Error ? e.message : e);
          }
        }

        if (rewritten) {
          items = items.map((item, i) => {
            const ai = rewritten![i];
            let header = (ai?.header || "").trim().replace(/\s*[\$€£¥]\d[\d,.]*/g, "").trim();
            let desc = (ai?.description || "").trim();

            // 长度安全网：超过 25 字符则回退到原始数据清理版
            if (header.length < 2 || header.length > 25) {
              header = item.header.replace(/\s*[\$€£¥]\s*\d[\d,.]*\+?/g, "").trim().slice(0, 25);
            }
            if (desc.length < 2 || desc.length > 25) {
              desc = (item.description || "").trim().slice(0, 25);
            }

            // header == description 冲突解决
            if (desc.toLowerCase() === header.toLowerCase() || desc.length < 2) {
              desc = `Shop ${merchantName}`.length <= 25 ? `Shop ${merchantName}` : "View details";
              if (desc.toLowerCase() === header.toLowerCase()) desc = "View details";
            }

            return { ...item, header, description: desc };
          });
          console.log(`[Price] AI batch rewrite 成功: ${items.length} 条产品标题/描述已重写`);
        } else {
          // AI 全部失败时的降级处理：清理原始数据
          items = items.map((item) => {
            let header = item.header
              .replace(/\s*[\$€£¥]\s*\d[\d,.]*\+?/g, "")
              .replace(/\s+/g, " ").trim().slice(0, 25);
            let desc = (item.description || "").trim().slice(0, 25);
            if (desc.toLowerCase() === header.toLowerCase() || desc.length < 2) {
              desc = `Shop ${merchantName}`.length <= 25 ? `Shop ${merchantName}` : "View details";
              if (desc.toLowerCase() === header.toLowerCase()) desc = "View details";
            }
            return { ...item, header, description: desc };
          });
          console.warn(`[Price] AI batch rewrite 全部失败，使用清理后的原始数据`);
        }
      } catch (outerErr) {
        console.error("[Price] AI rewrite 异常:", outerErr instanceof Error ? outerErr.message : outerErr);
      }

      let priceType = "Products";
      try {
        if (merchantName.split(" ").length === 1 || /store|shop|brand/i.test(cache.pageText)) {
          priceType = "Brands";
        } else if (/service|consult|plan|subscription/i.test(cache.pageText)) {
          priceType = "Services";
        }
      } catch {}
      send("price_items", { skipped: false, items, type: priceType });
      console.log(`[Optional] 价格信息: ${items.length} 条（AI 重写标题/描述）`);
    }
  }

  // ─── AI 生成类型：callouts + snippet + negative_keywords ───
  const needsAi = optionalTypes.filter((t) => !["call", "promotion", "price"].includes(t));

  if (needsAi.length > 0) {
    // 真实性原则：无爬虫数据时直接跳过，不用 AI 臆造内容
    const hasCrawlContent = cache.features.length > 0 || (cache.pageText || "").length > 20 ||
      cache.navItems.length > 0 || cache.links.length > 0;
    if (!hasCrawlContent) {
      console.log(`[Optional] 爬虫数据不足，跳过 AI 扩展生成: ${needsAi.join(", ")}`);
      if (needsAi.includes("callouts")) send("callouts", []);
      if (needsAi.includes("snippet")) send("structured_snippet", null);
      if (needsAi.includes("negative_keywords")) send("negative_keywords", []);
      return;
    }

    const sections: string[] = [];

    if (needsAi.includes("callouts")) {
      const featuresText = cache.features.length > 0
        ? cache.features.join(", ")
        : cache.pageText.slice(0, 500);
      sections.push(`## Callouts (宣传信息)
Generate exactly 6 callout extensions based ONLY on real merchant features.
Each callout: 2-25 characters STRICTLY. No generic placeholder text.
Merchant features / page content: ${featuresText}

Rules:
- Must be specific to THIS merchant (not generic like "Best Quality", "Shop Now")
- If free shipping confirmed: include it. If returns confirmed: include it.
- Focus on concrete features: materials, certifications, guarantees, unique attributes
- Do NOT fabricate discounts, numbers, or unverified claims`);
    }

    if (needsAi.includes("snippet")) {
      const contextItems = [...new Set([
        ...cache.navItems,
        ...cache.links.map((l) => l.text).filter((t) => t.length >= 2 && t.length <= 30),
      ])].slice(0, 30);
      sections.push(`## Structured Snippet (结构化摘要)
IMPORTANT: Choose header ONLY from this exact list (case-sensitive):
${GOOGLE_SNIPPET_HEADERS.map((h) => '"' + h + '"').join(", ")}

Extract 3-10 real category values (each ≤25 chars) from merchant content.
Available nav/link items: ${contextItems.slice(0, 20).map((t) => '"' + t + '"').join(", ")}

Choose the most appropriate header for this merchant type.`);
    }

    if (needsAi.includes("negative_keywords")) {
      sections.push(`## Negative Keywords (否定关键词)
Generate 10-20 negative keywords using Adrian's strategy.
Merchant: ${merchantName}, Products/Context: ${cache.features.slice(0, 5).join(", ") || cache.pageText.slice(0, 300)}

MUST include (where relevant):
- Price-sensitivity negatives: cheap, cheapest, free, wholesale, budget, bargain
- DIY/research intent: diy, how to make, tutorial, homemade, recipe
- Non-purchase intent: reddit, review only, forum, wiki, definition, meaning
- Competitor confusion: [if merchant is a specific brand, include generic category terms that don't match]
- Low-quality seekers: knockoff, replica, fake, imitation, generic
- Policy-risk negatives: If the merchant's product category could be confused with restricted content (e.g., mushroom supplies → add "magic", "psychedelic", "trip", "high"; knife store → add "weapon", "combat", "tactical assault"), add negatives that prevent ads from showing on policy-violating searches

Return ONLY single words or short phrases. No match-type brackets.`);
    }

    if (sections.length === 0) { await Promise.resolve(); return; }

    const prompt = `${AD_COPY_ANTI_AI_BLOCK}

Analyze this merchant and generate the requested Google Ads extensions.

CRITICAL: Only use facts from the website content. Do NOT invent product names, prices, or claims.

Merchant: ${merchantName}
Website: ${merchantUrl}
Target: ${market.countryNameZh} (${languageName})

Website content:
${cache.pageText.slice(0, 3000)}

${sections.join("\n\n")}

Return ONLY a valid JSON object with the applicable keys:
{
  ${needsAi.includes("callouts") ? '"callouts": ["c1","c2","c3","c4","c5","c6"],' : ""}
  ${needsAi.includes("snippet") ? `"snippet": { "header": "Types", "values": ["v1","v2","v3"] }${needsAi.includes("negative_keywords") ? "," : ""}` : ""}
  ${needsAi.includes("negative_keywords") ? '"negative_keywords": ["kw1","kw2",...]' : ""}
}`;

    try {
      const raw = await callAiWithFallback("ad_copy", [{ role: "user", content: prompt }], 4096);
      const parsed = JSON.parse(extractJsonFromAi(raw));

      if (needsAi.includes("callouts")) {
        let callouts: string[] = Array.isArray(parsed.callouts)
          ? parsed.callouts
              .map((c: string) => String(c || "").trim())
              .filter((c: string) => c.length >= 2 && c.length <= 25)
          : [];
        // 必须至少4条，不足则补充通用词
        if (callouts.length < 4) {
          const extras = cache.features
            .map((f) => f.slice(0, 25))
            .filter((f) => f.length >= 2 && !callouts.includes(f));
          callouts = [...callouts, ...extras].slice(0, 6);
        }
        const calloutFix = await complianceAutoFix(callouts, "headline", merchantName, languageName, aiRuleProfile, 25, 2);
        callouts = calloutFix.items;
        if (calloutFix.fixed.length > 0) send("compliance_auto_fix", { fixed: calloutFix.fixed, count: calloutFix.fixed.length });
        callouts = humanizeAdCopyBatch(callouts, 2, 25);
        send("callouts", callouts.slice(0, 6));
      }

      if (needsAi.includes("snippet")) {
        const snippet = parsed.snippet;
        if (snippet?.header && Array.isArray(snippet.values) && snippet.values.length >= 3) {
          const validHeader = validateSnippetHeader(String(snippet.header));
          let values = snippet.values
            .map((v: string) => String(v || "").trim())
            .filter((v: string) => v.length >= 2 && v.length <= 25)
            .slice(0, 10);
          values = humanizeAdCopyBatch(values, 2, 25);
          send("structured_snippet", values.length >= 3 ? { header: validHeader, values } : null);
        } else {
          send("structured_snippet", null);
        }
      }

      if (needsAi.includes("negative_keywords")) {
        const negKws: string[] = Array.isArray(parsed.negative_keywords)
          ? parsed.negative_keywords
              .map((k: string) => String(k || "").trim().toLowerCase())
              .filter((k: string) => k.length >= 2 && k.length <= 80)
              .slice(0, 20)
          : [];
        send("negative_keywords", negKws);
        console.log(`[Optional] 否定关键词: ${negKws.length} 条`);
      }

      console.log(`[Optional] AI 生成完成: ${needsAi.join(", ")}`);
    } catch (err) {
      console.error("[Optional] AI 生成失败:", err instanceof Error ? err.message : err);
      if (needsAi.includes("callouts")) send("callouts", []);
      if (needsAi.includes("snippet")) send("structured_snippet", null);
      if (needsAi.includes("negative_keywords")) send("negative_keywords", []);
    }
  }
}

// ─── 辅助函数 ───

async function fetchSubPagesForOptional(
  links: { url: string; text: string }[],
  needsAi: string[],
): Promise<{ promoText: string; priceItems: { header: string; description: string; price: number; currency: string; url: string }[] }> {
  let promoText = "";
  let priceItems: { header: string; description: string; price: number; currency: string; url: string }[] = [];

  const promoKeywords = ["sale", "deal", "offer", "promo", "discount", "coupon", "special", "clearance", "pricing"];
  const priceKeywords = ["pricing", "price", "plan", "shop", "product", "store", "buy", "collection"];

  const subLinks = links.filter((l) => {
    const lower = l.url.toLowerCase() + " " + l.text.toLowerCase();
    if (needsAi.includes("promotion") && promoKeywords.some((kw) => lower.includes(kw))) return true;
    if (needsAi.includes("price") && priceKeywords.some((kw) => lower.includes(kw))) return true;
    return false;
  }).slice(0, 4);

  const results = await Promise.allSettled(subLinks.map(async (link) => {
    const resp = await fetch(link.url, {
      signal: AbortSignal.timeout(8000),
      headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36" },
    });
    if (!resp.ok) return null;
    const html = await resp.text();
    const text = html.replace(/<script[\s\S]*?<\/script>/gi, "").replace(/<style[\s\S]*?<\/style>/gi, "").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim().slice(0, 2000);
    return { text, html, url: link.url };
  }));

  for (const r of results) {
    if (r.status === "fulfilled" && r.value) {
      promoText += `\n--- ${r.value.url} ---\n${r.value.text}`;
      if (needsAi.includes("price")) {
        const items = extractPriceInfo(r.value.html, "US", r.value.url);
        if (items.length > priceItems.length) priceItems = items;
      }
    }
  }

  return { promoText, priceItems };
}

async function extractPhoneFromCache(
  cache: CrawlCache,
  merchantUrl: string,
  country: string,
): Promise<{ country_code: string; phone_number: string } | null> {
  const CC: Record<string, string> = {
    US: "US", CA: "CA", GB: "GB", UK: "GB", AU: "AU",
    DE: "DE", FR: "FR", JP: "JP", IT: "IT", ES: "ES", NL: "NL",
    SE: "SE", NO: "NO", DK: "DK", BR: "BR",
  };
  const countryCode = CC[country.toUpperCase()] || "US";

  // 从缓存中选出第一个通过格式校验的号码
  // 不能盲目取 candidates[0]，历史缓存可能包含格式不正确的号码
  const { isValidPhoneForCountry: validate } = await import("@/lib/crawl-pipeline");
  for (const candidate of cache.phoneCandidates) {
    if (validate(candidate.phone_number, countryCode)) {
      return { country_code: countryCode, phone_number: candidate.phone_number };
    }
  }

  // 缓存无有效号码，尝试爬 contact 页面的 tel: href（最可靠来源）
  const contactLinks = cache.links.filter((l) =>
    /contact|about|impressum|kontakt|nous-contacter/i.test(l.url) || /contact|about/i.test(l.text),
  ).slice(0, 2);

  for (const link of contactLinks) {
    try {
      const resp = await fetch(link.url, {
        signal: AbortSignal.timeout(8000),
        headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36" },
      });
      if (!resp.ok) continue;
      const html = await resp.text();
      const telRegex = /href=["']tel:([^"']+)["']/gi;
      let m;
      while ((m = telRegex.exec(html)) !== null) {
        const phone = decodeURIComponent(m[1]).replace(/\s+/g, "").trim();
        if (validate(phone, countryCode)) {
          return { country_code: countryCode, phone_number: phone };
        }
      }
    } catch {}
  }

  // 找不到合格号码 → 返回 null，skip call extension
  console.log(`[Call] 未找到符合 ${countryCode} 格式的电话号码，跳过致电扩展`);
  return null;
}

// getDefaultCallouts 已移除 — callouts 必须基于真实商家特征由 AI 生成

const IMG_BLACKLIST = [
  "logo", "favicon", "icon", "avatar", "payment", "badge", "social", "flag", "arrow",
  "spinner", "loading", "placeholder", "blank", "footer", "newsletter",
  "trustpilot", "captcha", "pixel", "tracking", "facebook", "twitter", "instagram",
  "visa", "mastercard", "paypal", "ssl", "emoji", "1x1", "spacer",
  // D-095：信任/奖项/评分/担保类装饰图——COSMO(智能手表)实证：提取结果全是 Inc.5000 奖牌、
  // 退款/包邮/质保盾牌、Google 评分徽章、品牌 logo，无一张真实产品图。这些 URL 不含 logo/badge
  // 关键字时会漏过，故扩充黑名单一并硬剔（产品图文件名几乎不会含这些词，误杀风险极低）。
  "award", "guarantee", "warranty", "money-back", "moneyback", "moneyguarantee",
  "verified", "certified", "g2crowd", "capterra", "inc5000", "inc-5000", "inc_5000",
  "trust-badge", "trustbadge", "as-seen", "asseenon", "featured-in", "stars-",
  "google-review", "review-star", "five-star", "5-star",
];

// 已知图片 CDN 域名 — 跳过 HEAD 验证（这些域名只提供图片）
const KNOWN_IMAGE_CDNS = [
  "sensershop.com",           // senser.net Aliyun OSS CDN
  "cloudinary.com",
  "imgix.net",
  "cdn.shopify.com", "shopifycdn.com",
  "squarespace-cdn.com",
  "wixstatic.com",
  "akamaized.net",
  "cloudfront.net",
  "amazonaws.com",
];

// 基于 URL 路径给图片打相关性分数（越高越可能是产品图）
const imageRelevanceScore = (url: string): number => {
  const lower = url.toLowerCase();
  const path = (() => { try { return new URL(url).pathname.toLowerCase(); } catch { return lower.split("?")[0]; } })();
  let score = 0;
  // Positive: product-related paths
  if (/\/prd\/image\//i.test(path)) score += 60;
  if (/\/products?\//i.test(path)) score += 50;
  if (/\/catalog\/product/i.test(path)) score += 50;
  if (/\/media\/catalog/i.test(path)) score += 45;
  if (/\/(goods|item|sku)\//i.test(path)) score += 45;
  if (/\/cdn\/shop\/(files|products)\//i.test(path)) score += 45; // Shopify 新版产品图路径
  if (/\/(collection|shop)\//i.test(path)) score += 30;
  if (/\/upload\//i.test(path)) score += 25;
  // UUID in path = CDN-hosted media
  if (/\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i.test(path)) score += 15;
  // Aliyun OSS resize/interlace params = verified image
  if (url.includes("x-oss-process=image")) score += 25;
  // Large size hint
  const sizeMatch = lower.match(/[/_-](\d+)x(\d+)/);
  if (sizeMatch) { const w = parseInt(sizeMatch[1]); if (w >= 600) score += 20; else if (w >= 300) score += 8; }
  // Negative: site chrome / editorial / about pages
  if (/\/assets\/static\//i.test(path)) score -= 30;   // 降分不过滤（07确认：避免误杀部分产品图）
  if (/aboutus|about[-_]us/i.test(path)) score -= 40;
  if (/\/icons?\//i.test(path)) score -= 70;
  if (/-title\.(png|jpg|webp)$/i.test(path)) score -= 60;
  if (/\/(header|footer|nav|menu|sidebar)\//i.test(path)) score -= 70;
  if (/\/(email|newsletter|subscribe)\//i.test(path)) score -= 60;
  // D-095：信任/奖项/评分/担保/特性图标类装饰图重罚（漏过硬黑名单的也压到产品图之下）
  if (/award|medal|trophy|inc[-_]?5000|g2crowd|capterra|as[-_]?seen|featured[-_]?in/i.test(path)) score -= 90;
  if (/trust|guarantee|warrant|money[-_]?back|free[-_]?shipping|shipping[-_]?icon/i.test(path)) score -= 80;
  if (/rating|review|stars?|seal|certified|verified|endorse/i.test(path)) score -= 70;
  if (/feature[-_]?icon|benefit[-_]?icon|usp[-_]?icon|value[-_]?prop/i.test(path)) score -= 60;
  return score;
};

// 社交媒体域名 - 非品牌相关图片（规则：不能有文字、必须品牌强相关）
const SOCIAL_MEDIA_DOMAINS = [
  "instagram.com", "cdninstagram.com",
  "facebook.com", "fbcdn.net", "fbsbx.com",
  "twitter.com", "twimg.com",
  "tiktok.com", "tiktokcdn.com",
  "pinterest.com", "pinimg.com",
  "youtube.com", "ytimg.com",
  "snapchat.com", "snapchatcdn.com",
  "reddit.com", "redd.it",
  "tumblr.com",
];

// URL 路径中的促销/文字内容特征词（此类图片通常带大量文字覆盖，不是纯产品图）
// 注意：不过滤 /hero/ /banner/ /slide/ — 电商品牌常用这些路径存放产品主图
const TEXT_PROMO_URL_PATTERNS = [
  "/flyer", "/poster",
  "/announce", "/ad-creative", "/ads-creative",
  "percent-off", "pct-off", "%-off",
  "/graphic", "/infographic",
  "before-after", "before_after", "beforeafter",
  "/coupon",
];

// 前端最少接收图片数，无论如何必须达到
const MIN_IMAGES_TO_FRONTEND = 20;

/**
 * 移除 Aliyun OSS 残缺的图片处理参数。
 * 不完整的 x-oss-process=image/resize（缺少 w_/h_ 尺寸）会导致 OSS 返回 400。
 * 07确认：直接移除参数，让 CDN 返回原图。
 */
function normalizeImageUrl(url: string): string {
  try {
    const u = new URL(url);
    if (u.searchParams.has("x-oss-process")) {
      const processParam = (u.searchParams.get("x-oss-process") || "").trim();
      // 仅移除残缺参数：值为 "image/resize" 且无尺寸规格（有尺寸时如 image/resize,w_800 则保留）
      if (/^image\/resize\s*$/.test(processParam)) {
        u.searchParams.delete("x-oss-process");
        return u.toString();
      }
    }
    return url;
  } catch {
    return url;
  }
}

/**
 * 从商家页面内容提取主营业务关键词，用于提升产品图的相关性评分。
 * 若页面文本中有 ≥2 个来自同一品类的词，则认为商家主营该品类。
 */
function extractBusinessKeywords(pageText: string, features: string[]): string[] {
  const text = (pageText + " " + features.join(" ")).toLowerCase().slice(0, 3000);

  const DOMAIN_GROUPS: string[][] = [
    ["clothing", "apparel", "dress", "shirt", "jeans", "pants", "jacket", "coat", "fashion", "wear", "garment"],
    ["shoe", "boot", "sneaker", "footwear", "heel", "loafer", "sandal", "stiletto"],
    ["skincare", "moisturizer", "serum", "cleanser", "beauty", "cosmetic", "makeup", "cream", "lotion"],
    ["furniture", "sofa", "chair", "table", "bedroom", "kitchen", "decor", "interior"],
    ["outdoor", "camping", "hiking", "sports", "fitness", "gym", "running", "athletic"],
    ["jewelry", "necklace", "bracelet", "ring", "earring", "pendant", "diamond", "gemstone"],
    ["bag", "handbag", "backpack", "wallet", "purse", "luggage", "tote", "satchel"],
    ["electronics", "laptop", "phone", "tablet", "camera", "gadget", "headphone", "speaker", "earbud", "earbuds", "charger", "smart home", "router"],
    // D-095：可穿戴/智能手表（COSMO Technologies 实证：原 DOMAIN_GROUPS 无 watch/wearable，
    // 智能手表站拿不到业务关键词加成，导致产品图无法在评分上盖过徽章/logo）
    ["watch", "smartwatch", "smart watch", "wearable", "fitness tracker", "activity tracker", "heart rate", "step counter", "sleep tracking", "gps watch", "wristband", "watch band", "watch strap"],
    ["food", "organic", "supplement", "nutrition", "vitamin", "snack", "beverage", "grocery"],
    ["book", "stationery", "notebook", "art", "craft"],
    ["toy", "children", "kids", "game", "puzzle", "educational"],
    ["pet", "dog", "cat", "animal", "veterinary"],
  ];

  const result: string[] = [];
  for (const group of DOMAIN_GROUPS) {
    const matches = group.filter((kw) => text.includes(kw));
    if (matches.length >= 2) result.push(...group);
  }
  return [...new Set(result)];
}

// D-095b：Shopify 商家产品图采集。
// 实证（COSMO Technologies 儿童智能手表）：营销首页几乎只有 lifestyle/信任徽章/GPS 地图截图，
// 真正干净的产品图在 /products/<handle> 页；且其文件名是 /s/files/ 下的哈希，URL 启发式无法识别。
// Shopify 暴露 /products/<handle>.js 返回 images[] 干净产品图——直接从爬虫已发现的 /products/
// 链接取 handle 拉取，作为「产品图」最高优先注入选图池。非 Shopify 站自动跳过（不发无谓请求）。
async function collectShopifyProductImages(
  merchantUrl: string,
  cache: CrawlCache,
  maxProducts = 6,
): Promise<string[]> {
  let base: URL;
  try { base = new URL(merchantUrl); } catch { return []; }
  // 仅对疑似 Shopify 站发起（避免对任意站点打 /products/x.js 浪费请求）
  const looksShopify =
    (cache.images || []).some((u) => /cdn\.shopify\.com/i.test(u)) ||
    /cdn\.shopify\.com|myshopify\.com|shopify/i.test(cache.pageText || "");
  if (!looksShopify) return [];

  const baseHost = base.hostname.replace(/^www\./, "").toLowerCase();
  const linkPool: unknown[] = [
    ...(((cache as any).navLinks as unknown[]) || []),
    ...(((cache as any).sitelinkCandidates as unknown[]) || []),
    ...(((cache as any).links as unknown[]) || []),
  ];
  const handles: string[] = [];
  const seenHandle = new Set<string>();
  for (const l of linkPool) {
    const raw = typeof l === "string" ? l : (l as { url?: string })?.url;
    if (!raw) continue;
    let u: URL;
    try { u = new URL(raw, base.origin); } catch { continue; }
    if (u.hostname.replace(/^www\./, "").toLowerCase() !== baseHost) continue;
    const m = u.pathname.match(/\/products\/([^/?#]+)/i);
    if (!m) continue;
    const h = decodeURIComponent(m[1]).toLowerCase();
    if (!h || seenHandle.has(h)) continue;
    seenHandle.add(h);
    handles.push(h);
    if (handles.length >= maxProducts) break;
  }
  if (handles.length === 0) return [];

  const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";
  const results = await Promise.allSettled(
    handles.map(async (h) => {
      const resp = await fetch(`${base.origin}/products/${encodeURIComponent(h)}.js`, {
        headers: { "User-Agent": UA, Accept: "application/json" },
        signal: AbortSignal.timeout(8000),
      });
      if (!resp.ok) return [] as string[];
      const ct = resp.headers.get("content-type") || "";
      if (!/json|javascript/i.test(ct)) return [] as string[]; // 非 Shopify → 多为 text/html 404
      const data = (await resp.json().catch(() => null)) as { images?: unknown[] } | null;
      const arr = Array.isArray(data?.images) ? data!.images! : [];
      return arr
        .map((it) => (typeof it === "string" ? it : (it as { src?: string })?.src || ""))
        .map((s) => (s.startsWith("//") ? `https:${s}` : s))
        .filter((s) => /^https?:\/\//.test(s));
    }),
  );
  const out: string[] = [];
  const seenUrl = new Set<string>();
  for (const r of results) {
    if (r.status !== "fulfilled") continue;
    for (const u of r.value) {
      if (seenUrl.has(u)) continue;
      seenUrl.add(u);
      out.push(u);
    }
  }
  if (out.length > 0) {
    console.warn(`[Extensions] D-095b Shopify 产品图采集：handles=${handles.length} 取到产品图 ${out.length} 张`);
  }
  return out;
}

async function selectBestImages(
  rawImages: string[],
  merchantUrl?: string,
  merchantContext?: { pageText?: string; features?: string[]; priorityImages?: string[] },
): Promise<string[]> {
  // 解析商家主域名，用于品牌相关性判断
  let merchantDomain = "";
  if (merchantUrl) {
    try {
      const u = new URL(merchantUrl.startsWith("http") ? merchantUrl : `https://${merchantUrl}`);
      merchantDomain = u.hostname.replace(/^www\./, "");
    } catch { /* ignore */ }
  }

  const BROWSER_UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

  // 核心过滤（绝对黑名单：SVG / data-URI / 明确小图 / 社交域名 / 明显文字图片 / 追踪像素 / 站点外壳图）
  const hardFilter = (url: string): boolean => {
    const lower = url.toLowerCase();
    if (IMG_BLACKLIST.some((kw) => lower.includes(kw))) return false;
    if (lower.endsWith(".svg") || lower.startsWith("data:")) return false;
    // 追踪像素域名
    try { const h = new URL(url).hostname.toLowerCase(); if (/bat\.bing\.net|doubleclick\.net|googletagmanager\.com|analytics\./i.test(h)) return false; } catch {}
    const tinyMatch = lower.match(/[/_-](\d+)x(\d+)/);
    if (tinyMatch && (parseInt(tinyMatch[1]) < 150 || parseInt(tinyMatch[2]) < 150)) return false;
    try {
      const imgHostname = new URL(url).hostname.toLowerCase();
      if (SOCIAL_MEDIA_DOMAINS.some((d) => imgHostname === d || imgHostname.endsWith("." + d))) return false;
    } catch { /* ignore */ }
    const urlPath = (() => { try { return new URL(url).pathname.toLowerCase(); } catch { return lower.split("?")[0]; } })();
    if (TEXT_PROMO_URL_PATTERNS.some((p) => urlPath.includes(p))) return false;
    // 标题文字叠加图（确定含大量文字水印，直接丢弃）
    // /assets/static/ 和 aboutus 改为评分降权，不再硬过滤（避免误杀部分商家产品图）
    if (/-title\.(png|jpg|webp)$/i.test(urlPath)) return false;
    return true;
  };

  // 软过滤（URL 含按钮/徽标/精灵图特征）
  const TEXT_URL_PATTERNS = [/\/badge[s]?\//i, /\/label[s]?\//i, /\/text[s]?\//i, /\/overlay/i, /\/sprite[s]?\//i, /\/button[s]?\//i, /\bfavicon\b/i];
  const softFilter = (url: string): boolean => !TEXT_URL_PATTERNS.some((p) => p.test(url.toLowerCase()));

  // URL 规范化：移除 Aliyun OSS 残缺参数（x-oss-process=image/resize 无尺寸 → CDN返回400）
  // 07确认：移除参数，让 CDN 返回原图
  const seenUrls = new Set<string>();
  const normalizedImages = rawImages
    .map(normalizeImageUrl)
    .filter((url) => {
      if (seenUrls.has(url)) return false;
      seenUrls.add(url);
      return true;
    });

  const filtered = normalizedImages.filter(hardFilter);

  // 商家主营业务关键词（用于提升产品图相关性评分）
  const businessKeywords = merchantContext?.pageText
    ? extractBusinessKeywords(merchantContext.pageText, merchantContext.features || [])
    : [];
  if (businessKeywords.length > 0) {
    console.log(`[SelectImages] 检测到业务关键词: ${businessKeywords.slice(0, 8).join(", ")}`);
  }

  // D-095b：来自 Shopify 产品页 .js 的图片 = 确定的产品图，给最高优先（其 /s/files/ 哈希文件名
  // 无法靠 URL 启发式识别，故用集合显式加权，确保排在 lifestyle/徽章之上）。
  const prioritySet = new Set(
    (merchantContext?.priorityImages || []).map((u) => normalizeImageUrl(u)),
  );

  // 按产品相关性评分排序（高分 = 产品图，低分 = 品牌外壳图）
  const brandSuffix = merchantDomain ? merchantDomain.replace(/^[^.]+\./, "") : "";
  const scored = filtered.map((url) => {
    let score = imageRelevanceScore(url);
    if (prioritySet.has(url)) score += 200; // Shopify 产品页确证产品图，置顶
    // 商家业务关键词加成：URL 路径含主营业务词则加分
    if (businessKeywords.length > 0) {
      const urlPath = (() => {
        try { return new URL(url).pathname.toLowerCase(); } catch { return url.toLowerCase().split("?")[0]; }
      })();
      if (businessKeywords.some((kw) => urlPath.includes(kw))) score += 25;
    }
    // 品牌 CDN 加成：主域名同后缀的 CDN 域名（如 sensershop.com 对应 senser.net）
    try {
      const h = new URL(url).hostname.toLowerCase().replace(/^www\./, "");
      if (merchantDomain && (h.includes(merchantDomain) || (brandSuffix && h.endsWith(brandSuffix)))) score += 5;
    } catch {}
    return { url, score };
  });
  scored.sort((a, b) => b.score - a.score);
  const ranked = scored.map(s => s.url);

  // 兜底：硬过滤后太少，补入规范化后的原始列表
  const pool = ranked.length >= MIN_IMAGES_TO_FRONTEND ? ranked
    : [...ranked, ...normalizedImages.filter((u) => !ranked.includes(u) && !u.startsWith("data:") && !u.endsWith(".svg"))];

  // Step 1：HEAD 检查——使用浏览器 UA 避免 CDN 403；已知图片 CDN 跳过检查
  const isKnownImageCDN = (url: string): boolean => {
    try { const h = new URL(url).hostname.toLowerCase(); return KNOWN_IMAGE_CDNS.some(cdn => h === cdn || h.endsWith("." + cdn)); } catch { return false; }
  };
  const checked: string[] = [];
  for (let i = 0; i < pool.length && checked.length < 80; i += 10) {
    const batch = pool.slice(i, i + 10);
    const results = await Promise.allSettled(
      batch.map(async (url) => {
        // 已知图片 CDN / Aliyun OSS process 参数 → 确定是图片，跳过 HEAD
        if (isKnownImageCDN(url) || url.includes("x-oss-process=image")) return url;
        try {
          const resp = await fetch(url, { method: "HEAD", signal: AbortSignal.timeout(4000), headers: { "User-Agent": BROWSER_UA } });
          // 非 2xx 不一定不是图片（部分 CDN 不支持 HEAD 返回 403/405），保留
          if (!resp.ok) return url;
          const ct = resp.headers.get("content-type") || "";
          // 明确返回了非图片 content-type 才过滤（如 text/html → 确实不是图片）
          if (ct && !ct.startsWith("image/") && !ct.includes("octet-stream")) return null;
          const cl = parseInt(resp.headers.get("content-length") || "0", 10);
          if (cl > 0 && cl < 5000) return null; // 文件太小（< 5KB）
          return url;
        } catch { return url; } // 超时/报错：不过滤，保留
      }),
    );
    for (const r of results) if (r.status === "fulfilled" && r.value) checked.push(r.value);
    if (checked.length >= 40) break;
  }

  const headPassed = checked.length >= MIN_IMAGES_TO_FRONTEND ? checked
    : (checked.length > 0 ? [...checked, ...pool.filter(u => !checked.includes(u))].slice(0, 80) : pool.slice(0, 80));

  // Step 2：软过滤
  const cleanImages = headPassed.filter(softFilter);

  // Step 3：OCR 文字检测（07需求）—— 扫描 TOP 30 候选，词数 > 25 的文字密集图直接丢弃
  // 阈值调整：5→25，避免过度过滤产品图（Google Ads 禁止纯文字 banner，但允许产品上有少量文字）
  // 超时 / 出错 / 不可达 → 保留（不影响主流程）
  // C-119 低配机提速：OCR 候选 30→16（前端最终只要 20 张，OCR 仅精筛 TOP 候选即可），单张超时 8→5s
  const ocrCandidates = cleanImages.slice(0, 16);
  let ocrPassed: string[] = ocrCandidates;
  try {
    const { ocrFilterImages } = await import("@/lib/ocr-filter");
    ocrPassed = await ocrFilterImages(ocrCandidates, { wordThreshold: 25, imageTimeoutMs: 5000 });
  } catch (e) {
    console.warn("[SelectImages] OCR 过滤异常，保留原始候选:", e instanceof Error ? e.message : e);
  }

  // ─── 硬保障：精确返回 20 张（07确认） ───
  // 优先 OCR 通过的图片；不足时依次从 cleanImages → headPassed → pool → 原始列表补充
  let result: string[];
  if (ocrPassed.length >= MIN_IMAGES_TO_FRONTEND) {
    result = ocrPassed;
  } else {
    const supplemental = [
      ...cleanImages.filter((u) => !ocrCandidates.includes(u)),
      ...headPassed.filter((u) => !cleanImages.includes(u)),
      ...pool.filter((u) => !headPassed.includes(u)),
      ...normalizedImages.filter((u) => !pool.includes(u) && !u.startsWith("data:") && !u.endsWith(".svg")),
    ];
    result = [...ocrPassed, ...supplemental];
  }

  // D-059b: 折叠同一图片的尺寸/CDN 变体（foo-300x300.jpg / foo?w=600 / foo@2x.jpg / /300x300/ 段等），
  // 避免前端出现"同一张图重复多次"（07 报质量问题）。按相关性排序后保留每个规范键的首个（最高分）。
  const canonicalImageKey = (url: string): string => {
    try {
      const u = new URL(url);
      const p = u.pathname.toLowerCase()
        .replace(/[-_]\d{2,4}x\d{2,4}(?=\.[a-z0-9]+$)/i, "")
        .replace(/\/\d{2,4}x\d{2,4}\//i, "/")
        .replace(/@\d+(?:\.\d+)?x(?=\.[a-z0-9]+$)/i, "")
        .replace(/[-_](?:thumb(?:nail)?|small|medium|large|scaled|mini|compact)(?=\.[a-z0-9]+$)/i, "");
      return u.hostname.replace(/^www\./, "") + p;
    } catch { return url.toLowerCase().split("?")[0]; }
  };
  const seenCanonical = new Set<string>();
  const dedupResult: string[] = [];
  for (const u of result) {
    const k = canonicalImageKey(u);
    if (seenCanonical.has(k)) continue;
    seenCanonical.add(k);
    dedupResult.push(u);
  }
  result = dedupResult;

  const topScores = scored.slice(0, 5).map((s) => `${s.score}:${s.url.slice(-40)}`).join(" | ");
  console.log(
    `[SelectImages] raw=${rawImages.length} normalized=${normalizedImages.length} filtered=${filtered.length} headPassed=${headPassed.length} clean=${cleanImages.length} ocrPassed=${ocrPassed.length} canonicalDedup=${result.length} final=${Math.min(result.length, 20)} | topScores: ${topScores}`,
  );
  return result.slice(0, 20);
}

// ─── D-047 / C-115: 站内链接「只用爬虫真实 URL，AI 只写文案」───
//
// 07 验收铁律：sitelink 的 URL 必须是爬虫真实抓到的页面，绝不让 AI 编造 url_path
// （drhauschka 实证：orchestrator 让 AI 生成 /body-care /make-up 等不存在的路径 → 前端验证全 404）。
// 做法（复用 C-016 sitelinkPipeline 逻辑）：爬虫 sitelinkCandidates 真实 URL → autoExpandSitelinks
// 从 sitemap/robots 补充真实 URL（HEAD 验证）→ generateSitelinkTexts 只写 title/desc（强制 url=候选真实 url）。
async function buildRealSitelinks(opts: {
  cache: CrawlCache;
  merchantUrl: string;
  country: string;
  merchantName: string;
  languageCode: string;
}): Promise<Array<{ url: string; title: string; desc1: string; desc2: string }>> {
  const { cache, merchantUrl, country, merchantName, languageCode } = opts;

  // D-094：站内链接必须与「落地页 URL」同站（同注册域，允许子域）。
  // Google Ads 要求 sitelink 域名与 final URL 同域；avis.de 落地页配 secure.avis.co.uk 这类
  // 跨 ccTLD 链接（多国共用预订平台）会被判不同域→拒登，且对员工是「完全不匹配」的脏数据。
  // 这里用落地页 host 作为唯一基准，任何来源（navLinks/sitelinkCandidates/sitemap 扩源/旧缓存）
  // 的候选都过此闸；落地页 host 解析不出来时一律判不同站（不能验证就不冒险发跨域）。
  const merchantOriginHost = (() => {
    try { return new URL(merchantUrl).hostname.replace(/^www\./, "").toLowerCase(); } catch { return ""; }
  })();
  const isSameSite = (u: string): boolean => {
    if (!merchantOriginHost) return false;
    let host = "";
    try { host = new URL(u).hostname.replace(/^www\./, "").toLowerCase(); } catch { return false; }
    return host === merchantOriginHost
      || host.endsWith(`.${merchantOriginHost}`)
      || merchantOriginHost.endsWith(`.${host}`);
  };

  // ─── D-051（07 拍板）：首选 puppeteer 首页渲染出的真实导航链接 ───
  //   一次 puppeteer 已把首页 navLinks 拿全（CF 站也能拿到，因为首页是隐身浏览器过的验证）。
  //   旧逻辑只用 sitelinkCandidates（CF 站被 sitemap/robots/HEAD 403 挡到归零），navLinks 闲置。
  //   做法：navLinks → 同源+顶层路径+去重过滤 → 逐个"打得开"检测（只剔确定性死链，保留 CF-403，
  //         因 Google 自家爬虫仍可达，避免误杀）→ 真实可达的直接当 sitelink 候选。
  const navBaseline: Array<{ url: string; title: string; description: string }> = [];
  const rawNav = cache.navLinks || [];
  if (rawNav.length > 0) {
    const seen = new Set<string>();
    const filteredNav: Array<{ url: string; text: string }> = [];
    for (const l of rawNav) {
      if (!l.url || !l.url.startsWith("http")) continue;
      let u: URL;
      try { u = new URL(l.url); } catch { continue; }
      if (!isSameSite(l.url)) continue;
      const segs = u.pathname.split("/").filter(Boolean);
      if (segs.length < 1 || segs.length > 2) continue; // 只要顶层栏目页（首页和深层产品页都排除）
      if (isBadSitelinkUrl(l.url)) continue;
      const key = (u.origin + u.pathname).replace(/\/$/, "").toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      filteredNav.push({ url: u.toString(), text: l.text });
      if (filteredNav.length >= 12) break;
    }
    const checks = await Promise.all(
      filteredNav.map(async (l) => {
        try {
          const r = await checkReachability(l.url, { maxRetries: 1, timeoutMs: 6000 });
          return { l, dead: isHardUnreachable(r) };
        } catch {
          return { l, dead: false };
        }
      }),
    );
    for (const c of checks) {
      if (c.dead) continue;
      navBaseline.push({ url: c.l.url, title: (c.l.text || "").slice(0, 25), description: "" });
      if (navBaseline.length >= 6) break;
    }
    console.warn(
      `[Intellicenter] buildRealSitelinks D-051: navLinks raw=${rawNav.length} filtered=${filteredNav.length} reachable=${navBaseline.length}`,
    );
  }

  // navLinks 真实候选优先，其次旧 sitelinkCandidates；navLinks 已凑够 6 条则跳过 sitemap/robots 扩源
  const baseline = [
    ...navBaseline,
    ...(cache.sitelinkCandidates || []).map((s) => ({
      url: s.url,
      title: s.title,
      description: s.description,
    })),
  ];
  const expanded = navBaseline.length >= 6
    ? baseline
    : await autoExpandSitelinks({ merchantUrl, country, existing: baseline, targetCount: 6 });
  // 去重（保序）+ 同站闸（D-094），最多取前 8 条作为 AI 输入缓冲。
  // 同站闸在此统一兜底：sitelinkCandidates / autoExpand / 旧缓存等任意来源的跨域候选一律剔除，
  // 保证落地页 avis.de 不会配出 secure.avis.co.uk 这类与落地页不同域的站内链接。
  const unique: typeof expanded = [];
  const seen = new Set<string>();
  let crossSiteDropped = 0;
  for (const s of expanded) {
    if (!isSameSite(s.url)) { crossSiteDropped++; continue; }
    const norm = s.url.replace(/\/$/, "").replace(/^http:/, "https:").toLowerCase();
    if (seen.has(norm)) continue;
    seen.add(norm);
    unique.push(s);
    if (unique.length >= 8) break;
  }
  if (crossSiteDropped > 0) {
    console.warn(`[Intellicenter] buildRealSitelinks D-094：剔除 ${crossSiteDropped} 条与落地页(${merchantOriginHost})不同域的站内链接候选`);
  }
  if (unique.length === 0) {
    console.warn(`[Intellicenter] buildRealSitelinks: 无真实候选（merchantUrl=${merchantUrl}），返回空`);
    return [];
  }
  const aiInputs = unique.map((s) => ({ url: s.url, pageTitle: s.title, pageDescription: s.description }));
  const written = await generateSitelinkTexts(aiInputs, { brandRoot: merchantName, country, languageCode });
  const filtered = written.filter((s) => !isLowValueSitelink(s.url, s.title));
  console.warn(
    `[Intellicenter] buildRealSitelinks: candidates=${baseline.length} expanded=${expanded.length} ai_written=${written.length} final=${filtered.slice(0, 6).length}`,
  );
  return filtered.slice(0, 6);
}

// ─── C-112 / D-046.C: 8 步 AI 智能闭环 wrapper ───
//
// 本函数完全替换原 generateCore 主路径（headlines + descriptions + sitelinks + callouts）。
// 流程：
//   1. 准备多源候选关键词（员工 confirmed + DB fallback + 爬虫 semrushTitles + suggestedKeywords）
//   2. 准备预算 / CPC 三因子（X4=C 决策依据）
//   3. 调 orchestrator.runIntelligentAdCreation 跑完 Step 1-8
//   4. 把 result 拆成现有 SSE 事件类型（headlines / descriptions / sitelinks / callouts）
//   5. 顺手 emit images（保留 image_urls 写入）
//   6. orchestrator 整体失败时降级到原 generateCore（保业务不挂）
async function runIntelligentCore(
  cache: CrawlCache,
  merchant: { id: bigint; merchant_name: string | null; merchant_url: string | null; category: string | null },
  campaign: { id: bigint; target_country: string | null },
  merchantName: string,
  merchantUrl: string,
  country: string,
  adSettings: any,
  aiRuleProfile: unknown,
  adCreativeId: bigint | null,
  send: (type: string, data: unknown) => void,
  adLanguageCode?: string,
  confirmedKeywords: string[] = [],
  merchantCategory: string | null = null,
  dbKeywordsForFallback: string[] = [],
): Promise<void> {
  const market = getAdMarketConfig(country);
  const languageName = resolveLanguageName(adLanguageCode || market.languageCode);

  // ─── 1. 多源候选关键词 ───
  const candidates: KeywordCandidate[] = [];
  for (const k of confirmedKeywords.slice(0, 12)) {
    // 员工已确认的关键词 — 最高优先级
    candidates.push({ text: k, source: "history", sourcePriority: 0 });
  }
  for (const k of dbKeywordsForFallback.slice(0, 12)) {
    candidates.push({ text: k, source: "history", sourcePriority: 1 });
  }
  // SemRush 标题中的关键词（C-112 Step 5 5 源融合的 SemRush 入口）
  if (Array.isArray(cache.semrushTitles)) {
    for (const t of cache.semrushTitles.slice(0, 12)) {
      candidates.push({ text: t.toLowerCase(), source: "semrush", sourcePriority: 2 });
    }
  }
  // 爬虫提取的 features（关键词候选）
  if (Array.isArray(cache.features)) {
    for (const f of cache.features.slice(0, 8)) {
      candidates.push({ text: f.toLowerCase(), source: "crawl", sourcePriority: 3 });
    }
  }

  // ─── 2. 预算 / CPC 归一化（按 USD 当量近似处理）───
  const dailyBudgetUsd = Number(adSettings?.daily_budget ?? 2);
  const maxCpcUsd = Number(adSettings?.max_cpc ?? 0.3);

  // ─── 3. 构造任务清单（headlines×10 + descriptions×4 + callouts×6）───
  //   D-047/C-115: sitelink 从 orchestrator 移除 —— 不再让 AI 编造 url_path，
  //   改由 buildRealSitelinks 用爬虫真实 URL 生成（与 orchestrator 并行，不增加总耗时）。
  const tasks: OrchestratorTask[] = [
    // C-117: 标题满 15、描述满 4（Google Ads RSA 上限，07 铁律必须填满）
    { kind: "headlines", count: 15, maxLen: 30 },
    { kind: "descriptions", count: 4, maxLen: 90, minLen: 40 },
    { kind: "callouts", count: 6, maxLen: 25 },
  ];

  // 真实 sitelink 与 orchestrator 并行启动（爬虫真实 URL + AI 只写文案，绝不编造路径）
  const realSitelinksPromise = buildRealSitelinks({
    cache,
    merchantUrl,
    country,
    merchantName,
    languageCode: adLanguageCode || market.languageCode,
  }).catch((e) => {
    console.warn(`[Intellicenter] buildRealSitelinks 异常（推空）: ${e instanceof Error ? e.message : e}`);
    return [] as Array<{ url: string; title: string; desc1: string; desc2: string }>;
  });

  // ─── D-050: 行业识别 + 加载拒登负样本（同商家强约束 + 同行业软提示）───
  let rejectionFeedback: Awaited<ReturnType<typeof import("@/lib/intellicenter/ad-creation/rejection-feedback").loadRejectionFeedbackForGeneration>> | null = null;
  let detectedIndustry: import("@/lib/industry-profile").IndustryProfile | null = null;
  try {
    const { detectIndustryProfile } = await import("@/lib/industry-profile");
    detectedIndustry = detectIndustryProfile({
      merchantName,
      category: merchantCategory,
      pageText: cache.pageText,
    });
    const { loadRejectionFeedbackForGeneration } = await import("@/lib/intellicenter/ad-creation/rejection-feedback");
    const campaignOwner = await prisma.campaigns.findUnique({
      where: { id: campaign.id },
      select: { user_id: true },
    });
    if (campaignOwner) {
      rejectionFeedback = await loadRejectionFeedbackForGeneration({
        userId: campaignOwner.user_id,
        userMerchantId: merchant.id,
        industryId: detectedIndustry?.id ?? null,
      });
      const sm = rejectionFeedback.sameMerchant.length;
      const si = rejectionFeedback.sameIndustry.length;
      if (sm > 0 || si > 0) {
        console.log(`[Intellicenter] D-050 拒登负样本注入: 同商家=${sm} 同行业=${si}`);
        send("rejection_feedback_loaded", { sameMerchant: sm, sameIndustry: si });
      }
    }
  } catch (e) {
    console.warn(`[Intellicenter] D-050 拒登负样本加载失败（不阻断）: ${e instanceof Error ? e.message : e}`);
  }

  try {
    const result = await runIntelligentAdCreation({
      merchantId: merchant.id,
      campaignId: campaign.id,
      merchantName,
      merchantUrl,
      finalUrl: merchantUrl,
      targetCountry: country,
      languageName,
      existingCrawlCache: cache,
      candidateKeywords: candidates,
      dailyBudgetUsd,
      maxCpcUsd,
      tasks,
      emitSSE: send,
      industryProfile: detectedIndustry,
      rejectionFeedback,
    });

    // 政策阻断：返回 0 文案 + 已 emit policy_blocked，前端会显示阻断 banner
    if (!result.approved) {
      console.warn(
        `[Intellicenter] merchant=${merchant.id} 政策阻断: ${result.blockingReasons.join(" | ")}`,
      );
      send("headlines", []);
      send("descriptions", []);
      send("sitelinks", []);
      send("callouts", []);
      return;
    }

    // 反 AI / 人性化（保留 D-039 humanize 兜底）
    // D-047/C-116: 硬截断到 Google Ads 长度上限 —— humanizeAdCopyBatch 遇超长会「返回原文不截断」
    //   （保语义设计），导致 AI 偶发输出 27 字符 callout（限 25）漏到前端标红甚至被 Google 拒登。
    //   这里统一兜底：超长项用 smartTruncate 在词边界截断 + 硬 slice 保证 ≤max，空项剔除。
    const clampLen = (arr: string[], max: number): string[] =>
      (arr || [])
        .map((s) => (typeof s === "string" && s.length > max ? smartTruncate(s, max).slice(0, max) : s))
        .filter((s) => typeof s === "string" && s.trim().length > 0);

    const humanizedHeadlines = result.headlines.length > 0
      ? clampLen(humanizeAdCopyBatch(result.headlines, 2, 30), 30)
      : [];
    const humanizedDescriptions = result.descriptions.length > 0
      ? clampLen(humanizeAdCopyBatch(result.descriptions, 40, 90), 90)
      : [];
    const humanizedCallouts = result.callouts.length > 0
      ? clampLen(humanizeAdCopyBatch(result.callouts, 2, 25), 25)
      : [];

    // ── D-082：禁止词自动避障（生成阶段，预览不出现禁止词）──
    //   humanize 可能重新引入禁止词，故放在 humanize 之后。命中 → AI 改写最多 3 轮；
    //   3 轮仍失败则保留原文（保数量），由提交阶段统一硬挡兜底通知员工。
    try {
      const _forbidden = resolveForbiddenTerms(aiRuleProfile);
      if (_forbidden.length > 0) {
        const _callAi = (prompt: string) =>
          callAiWithFallback("forbidden_rewrite", [{ role: "user", content: prompt }], 120);
        if (humanizedHeadlines.length > 0) {
          const r = await autoRewriteForbiddenTerms(humanizedHeadlines, _forbidden, { fieldLabel: "ad headline", maxChars: 30, caseStyle: "title", callAi: _callAi });
          humanizedHeadlines.splice(0, humanizedHeadlines.length, ...r.items);
          if (r.rewroteCount > 0 || r.stillViolating.length > 0) console.warn(`[D-082] 生成阶段标题禁止词改写：rewrote=${r.rewroteCount} stillViolating=${r.stillViolating.length}`);
        }
        if (humanizedDescriptions.length > 0) {
          const r = await autoRewriteForbiddenTerms(humanizedDescriptions, _forbidden, { fieldLabel: "ad description", maxChars: 90, caseStyle: "sentence", callAi: _callAi });
          humanizedDescriptions.splice(0, humanizedDescriptions.length, ...r.items);
          if (r.rewroteCount > 0 || r.stillViolating.length > 0) console.warn(`[D-082] 生成阶段描述禁止词改写：rewrote=${r.rewroteCount} stillViolating=${r.stillViolating.length}`);
        }
        if (humanizedCallouts.length > 0) {
          const r = await autoRewriteForbiddenTerms(humanizedCallouts, _forbidden, { fieldLabel: "callout", maxChars: 25, caseStyle: "title", callAi: _callAi });
          humanizedCallouts.splice(0, humanizedCallouts.length, ...r.items);
          if (r.rewroteCount > 0 || r.stillViolating.length > 0) console.warn(`[D-082] 生成阶段标注禁止词改写：rewrote=${r.rewroteCount} stillViolating=${r.stillViolating.length}`);
        }
      }
    } catch (e) {
      console.warn("[D-082] 生成阶段禁止词改写异常（不阻断）：", e instanceof Error ? e.message : e);
    }

    // C-116: 主体文案（headlines/descriptions/callouts）先 send + 存库 + 完成日志，
    //   绝不被 sitelink 阻塞 —— 旧逻辑把 `await realSitelinksPromise` 放在 callouts/存库/完成日志之前，
    //   sitelink 慢（爬虫候选不足时走 sitemap/Puppeteer 兜底）会卡住整条 SSE → 前端「一直转、生成不出来」。
    send("headlines", humanizedHeadlines);
    send("descriptions", humanizedDescriptions);
    if (humanizedCallouts.length > 0) {
      send("callouts", humanizedCallouts);
    }

    // 持久化主体（headlines / descriptions / callouts）
    if (adCreativeId) {
      try {
        await prisma.ad_creatives.update({
          where: { id: adCreativeId },
          data: {
            headlines: humanizedHeadlines as any,
            descriptions: humanizedDescriptions as any,
            callouts: humanizedCallouts as any,
          },
        });
      } catch (e) {
        console.warn(
          `[Intellicenter] ad_creatives 主体持久化失败: ${e instanceof Error ? e.message : e}`,
        );
      }
    }

    // C-116: 主体（标题/描述/宣传）已 send + 存库 → 通知前端 banner 立即消失（sitelink 慢也不拖住整页）
    send("core_done", { headlines: humanizedHeadlines.length, descriptions: humanizedDescriptions.length, callouts: humanizedCallouts.length });

    // 诊断输出：主体完成（sitelink 异步随后补，不计入此行）
    console.log(
      `[Intellicenter] merchant=${merchant.id} approved=${result.approved} timings=${JSON.stringify(result.timings)} aiCalls=${JSON.stringify(result.aiCalls)} headlines=${humanizedHeadlines.length}/${tasks[0].count} descriptions=${humanizedDescriptions.length}/${tasks[1].count} callouts=${humanizedCallouts.length}/${tasks[2].count} simAvgH=${result.similarity.headlines?.avgSimilarity?.toFixed(2) ?? "-"} simAvgD=${result.similarity.descriptions?.avgSimilarity?.toFixed(2) ?? "-"} lintDropped=${result.linter?.droppedCount ?? 0}`,
    );

    // D-047/C-115 + C-116: sitelink 最后单独 send + 存库（爬虫真实 URL，含 url 字段；慢也不影响主体）
    const realSitelinks = await realSitelinksPromise;
    send("sitelinks", realSitelinks);
    if (adCreativeId && realSitelinks.length > 0) {
      await prisma.ad_creatives
        .update({ where: { id: adCreativeId }, data: { sitelinks: realSitelinks as any } })
        .catch((e) => console.warn(`[Intellicenter] sitelink 持久化失败: ${e instanceof Error ? e.message : e}`));
    }
    console.log(`[Intellicenter] merchant=${merchant.id} sitelinks=${realSitelinks.length}/6(real-url) 完成`);
  } catch (err) {
    // orchestrator 整体异常（极少见）→ 降级到原 generateCore 让员工业务能继续
    console.error(
      `[Intellicenter] orchestrator 异常，降级原 generateCore: ${err instanceof Error ? err.message : err}`,
    );
    await generateCore(
      cache,
      merchantName,
      merchantUrl,
      country,
      adSettings,
      aiRuleProfile,
      adCreativeId,
      send,
      adLanguageCode,
      confirmedKeywords,
      merchantCategory,
      dbKeywordsForFallback,
    );
  }
}
