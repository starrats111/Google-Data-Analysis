import { NextRequest } from "next/server";
import { getUserFromRequest, serializeData } from "@/lib/auth";
import { apiSuccess, apiError } from "@/lib/constants";
import { SemRushClient, type SemRushKeyword } from "@/lib/semrush-client";
import { isPolicyRiskKeyword } from "@/lib/keyword-optimizer";
import { callAiWithFallback } from "@/lib/ai-service";

/**
 * POST /api/user/ad-creation/semrush
 * 关键词来源：SEMrush 主要付费关键词（top 1-2）+ AI 生成词（2-3）
 */

/** 从付费关键词中按 trafficPercent × volume 取 top 1-2 */
function selectPaidKeywords(paidKws: SemRushKeyword[], limit = 2) {
  return paidKws
    .filter((kw) => kw.phrase && !isPolicyRiskKeyword(kw.phrase))
    .sort((a, b) => {
      const scoreA = (a.trafficPercent ?? 0) * (a.volume ?? 0);
      const scoreB = (b.trafficPercent ?? 0) * (b.volume ?? 0);
      return scoreB - scoreA;
    })
    .slice(0, limit)
    .map((kw) => ({
      phrase: kw.phrase,
      volume: kw.volume ?? 0,
      cpc: kw.cpc ?? null,
      suggested_bid: kw.suggested_bid ?? null,
      competition: kw.competition ?? null,
      source: "semrush_paid",
      recommended_match_type: "EXACT",
      score: null,
      reason: `SEMrush 主要付费关键词，月搜索量 ${kw.volume ?? 0}，流量占比 ${(kw.trafficPercent ?? 0).toFixed(1)}%`,
      competition_band: null,
      intent_layer: "BRAND",
    }));
}

/** AI 根据自然搜索关键词 + 商家信息，生成 2-3 个建议关键词 */
async function generateAiKeywords(
  organicKeywords: SemRushKeyword[],
  merchantName: string,
  domain: string,
): Promise<object[]> {
  const topOrganic = organicKeywords
    .slice(0, 10)
    .map((kw) => kw.phrase)
    .filter(Boolean)
    .join(", ");
  if (!topOrganic) return [];

  try {
    const raw = await callAiWithFallback(
      "ad_copy",
      [
        {
          role: "user",
          content: `You are a Google Ads keyword expert. Based on the merchant information and their organic search keywords, suggest 2-3 additional high-intent Google Ads keywords.

Merchant name: ${merchantName || domain}
Website: ${domain}
Top organic keywords: ${topOrganic}

Requirements:
- Keywords must be relevant to the merchant's products/services
- Prefer purchase-intent or feature/category terms (e.g. "buy", "shop", "sale", "best", product category names)
- 2-5 words per keyword
- Do NOT exactly repeat any of the provided organic keywords
- Return ONLY a valid JSON array of strings, nothing else

Example output: ["women's designer dresses", "buy formal dress online", "evening gowns sale"]`,
        },
      ],
      300,
    );

    const match = raw.match(/\[[\s\S]*?\]/);
    if (!match) return [];
    const parsed: unknown = JSON.parse(match[0]);
    if (!Array.isArray(parsed)) return [];

    return (parsed as unknown[])
      .map((p) => String(p || "").trim())
      .filter((p) => p.length >= 2 && !isPolicyRiskKeyword(p))
      .slice(0, 3)
      .map((phrase) => ({
        phrase,
        volume: null,
        cpc: null,
        suggested_bid: null,
        competition: null,
        source: "ai_generated",
        recommended_match_type: "PHRASE",
        score: null,
        reason: "AI 根据商家信息和自然搜索关键词生成",
        competition_band: null,
        intent_layer: "HIGH_INTENT",
      }));
  } catch (err) {
    console.warn(
      "[SemRush AI Keywords] AI 生成失败:",
      err instanceof Error ? err.message : String(err),
    );
    return [];
  }
}

export async function POST(req: NextRequest) {
  try {
    const user = getUserFromRequest(req);
    if (!user) return apiError("未授权", 401);

    const { merchant_url, country = "US", merchant_name = "" } = await req.json();
    if (!merchant_url) return apiError("缺少商家 URL");

    const client = await SemRushClient.fromConfig(country);
    const result = await client.queryDomain(merchant_url);

    // Step 1: 付费关键词 top 1-2（按 trafficPercent × volume）
    const paidKeywords = selectPaidKeywords(result.paidKeywords, 2);

    // Step 2: AI 根据自然搜索词生成 2-3 个关键词
    const domain = result.domain;
    const aiKeywords = await generateAiKeywords(result.keywords, merchant_name, domain);

    // 合并去重（付费词优先）
    const seen = new Set<string>();
    const allKeywords = [...paidKeywords, ...aiKeywords].filter((kw) => {
      const key = (kw as any).phrase.toLowerCase();
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });

    return apiSuccess(
      serializeData({
        domain: result.domain,
        deduped_titles: result.dedupedTitles,
        deduped_descriptions: result.dedupedDescriptions,
        keywords: allKeywords,
        raw_keyword_count: result.keywords.length,
        paid_keyword_count: result.paidKeywords.length,
        total_copies: result.copies.total,
        creative_samples_count: result.creativeSamples.length,
      }),
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("[SemRush API]", msg);
    if (msg.includes("凭据未配置")) {
      return apiError("SemRush 功能未配置，请联系管理员在后台设置 SemRush/3UE 凭据");
    }
    return apiError(msg || "SemRush 查询失败，请稍后再试");
  }
}
