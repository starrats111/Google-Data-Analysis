/**
 * L1: 商家主营业务摘要提炼
 *
 * 目的：从爬取到的 pageText / meta 文本 / category 信息中，用 haiku 提炼一段 30-150 字的
 *      "主营业务一句话说明"，作为广告文案生成（generateCore）的最高优先级上下文，
 *      让 AI 从一开始就知道"这家是干嘛的"，避免从商家名字面瞎猜业务方向
 *      （C-094.16 真实案例：Camplify Spain 因 pageText 为空被 AI 误读成 "Camp Spa" 写水疗文案）。
 *
 * 输出存放：写入 ad_creatives.crawl_cache.businessSummary（JSON 字段，零 schema 改动）。
 *           下次进同一 ad_creative 时直接命中缓存，不重复调 AI。
 */
import { callAiWithFallback } from "@/lib/ai-service";
import { extractJsonFromAi } from "@/lib/crawl-pipeline";

export interface BusinessSummaryInput {
  merchantName: string;
  merchantUrl?: string;
  category?: string | null;
  pageText: string;     // 来自 crawl_cache.pageText，已含 meta 兜底
  features?: string[];
  countryName?: string; // 目标市场（中文），便于 AI 输出对应语言
}

export interface BusinessSummary {
  summary_en: string;   // 英文摘要（30-150 字），用于 AI prompt 注入
  category_guess: string; // AI 推断的细分品类（如 "P2P RV rental marketplace"）
  confidence: "high" | "medium" | "low"; // 输入充足度自评
  source_tokens: number; // 输入 token 估算（用于调试）
  generated_at: string;
}

const MIN_PAGE_TEXT = 80; // 少于 80 字的 pageText 不调 AI（避免浪费 token）

/**
 * 用 haiku 提炼 30-150 字英文业务摘要。
 *
 * Prompt 设计原则：
 *   - 强制只读"提供的事实"，不要"凭商家名猜"
 *   - 输入不足时返回 confidence="low" + 简短说明，让上层决定是否注入 prompt
 *   - 永远返回结构化 JSON，方便上层判断和持久化
 */
export async function extractBusinessSummary(
  input: BusinessSummaryInput,
): Promise<BusinessSummary | null> {
  const { merchantName, merchantUrl, category, pageText, features = [] } = input;
  if (!pageText || pageText.length < MIN_PAGE_TEXT) {
    return null; // 上下文不足，跳过 AI（generate-extensions L2 守门也会拦下）
  }

  const featBlock = features.length > 0
    ? `\nMerchant features detected on site:\n${features.slice(0, 10).join("\n")}\n`
    : "";

  const prompt = `You are analyzing a merchant for a Google Ads writer. The writer needs a concise, factual summary so they understand what the merchant ACTUALLY sells. Be precise. Never guess from the brand name alone.

Merchant: ${merchantName}${merchantUrl ? `\nWebsite: ${merchantUrl}` : ""}${category ? `\nCategory tag from affiliate platform: ${category}` : ""}

Below is the only information you may use — DO NOT invent anything not supported by this text:
${pageText.slice(0, 5000)}
${featBlock}
Return ONLY a JSON object with this exact structure:
{
  "summary_en": "<30-150 chars English summary of what this merchant sells/offers. Be specific about the business model (e.g. 'marketplace', 'subscription', 'D2C retailer', 'P2P rental', 'SaaS'). Avoid vague words like 'premium', 'innovative'.>",
  "category_guess": "<5-15 word descriptive category, e.g. 'P2P recreational vehicle rental marketplace' or 'D2C men's grooming subscription'>",
  "confidence": "<one of: high | medium | low — based on how well the source text describes the business>"
}

Rules:
1. If the text is so generic you can only guess from the brand name, return confidence "low" and write a cautious summary.
2. Never repeat the merchant name in summary_en more than once.
3. Output VALID JSON only. No explanation outside JSON.`;

  try {
    const raw = await callAiWithFallback("ad_copy", [{ role: "user", content: prompt }], 512);
    const parsed = JSON.parse(extractJsonFromAi(raw)) as Partial<BusinessSummary>;
    if (!parsed.summary_en || typeof parsed.summary_en !== "string") return null;
    const trimmed = parsed.summary_en.trim();
    if (trimmed.length < 20) return null; // 过短摘要不存（不如不存）
    return {
      summary_en: trimmed.slice(0, 300),
      category_guess: (parsed.category_guess || "").toString().slice(0, 120),
      confidence: (["high", "medium", "low"].includes(parsed.confidence as string) ? parsed.confidence : "medium") as BusinessSummary["confidence"],
      source_tokens: Math.ceil(pageText.length / 4),
      generated_at: new Date().toISOString(),
    };
  } catch (err) {
    console.warn("[BusinessSummary] AI 摘要失败:", err instanceof Error ? err.message : err);
    return null;
  }
}

/**
 * 把业务摘要格式化为可插入 generateCore prompt 的上下文块。
 * 返回空字符串表示无可用摘要，prompt 不注入。
 */
export function formatBusinessSummaryBlock(summary: BusinessSummary | null | undefined, category?: string | null): string {
  if (!summary || !summary.summary_en) {
    return category ? `\n⚡ Affiliate-platform category tag: ${category}\n` : "";
  }
  const confidenceNote = summary.confidence === "low"
    ? " (low confidence — please prefer page content over this summary)"
    : "";
  return `\n⚡ MERCHANT BUSINESS SUMMARY${confidenceNote}:\n${summary.summary_en}${summary.category_guess ? `\nBusiness model: ${summary.category_guess}` : ""}${category ? `\nAffiliate-platform tag: ${category}` : ""}\n`;
}
