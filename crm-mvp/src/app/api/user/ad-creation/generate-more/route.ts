import { NextRequest } from "next/server";
import { getUserFromRequest } from "@/lib/auth";
import { apiSuccess, apiError } from "@/lib/constants";
import prisma from "@/lib/prisma";
import { padHeadlines, padDescriptions, callAiWithFallback } from "@/lib/ai-service";
import { checkItemViolations } from "@/lib/ai-rule-profile";
import { extractJsonFromAi } from "@/lib/crawl-pipeline";
import { getAdMarketConfig, resolveLanguageName } from "@/lib/ad-market";

const MAX_COMPLIANCE_RETRIES = 3;

/**
 * POST /api/user/ad-creation/generate-more
 * AI 生成更多标题或描述（基于已有内容补充）
 */
export async function POST(req: NextRequest) {
  const user = getUserFromRequest(req);
  if (!user) return apiError("未授权", 401);

  const { type, existing, merchant_name, country, count, keywords = [], headlines_for_uniqueness = [], daily_budget, max_cpc, bidding_strategy, ad_language } = await req.json();

  if (!type || !["headlines", "descriptions"].includes(type)) {
    return apiError("type 必须为 headlines 或 descriptions");
  }

  const existingItems = Array.isArray(existing) ? existing.filter((s: string) => s?.trim()) : [];
  const targetCount = Math.min(count || (type === "headlines" ? 15 : 4), type === "headlines" ? 15 : 4);
  const settings = await prisma.ad_default_settings.findFirst({
    where: { user_id: BigInt(user.userId), is_deleted: 0 },
    select: { ai_rule_profile: true },
  });

  try {
    let newItems: string[];
    const market = getAdMarketConfig(country || "US");
    const languageName = resolveLanguageName(country || "US", ad_language);

    if (type === "headlines") {
      const result = await padHeadlines(existingItems, merchant_name || "", country || "US", targetCount, {
        keywords: Array.isArray(keywords) ? keywords.map((k: string) => String(k).trim()).filter(Boolean) : [],
        dailyBudget: Number(daily_budget || 0),
        maxCpc: Number(max_cpc || 0),
        biddingStrategy: bidding_strategy,
        aiRuleProfile: settings?.ai_rule_profile,
        adLanguageCode: ad_language,
      });
      newItems = result.filter((h) => !existingItems.includes(h));
    } else {
      const result = await padDescriptions(existingItems, merchant_name || "", country || "US", targetCount, {
        keywords: Array.isArray(keywords) ? keywords.map((k: string) => String(k).trim()).filter(Boolean) : [],
        headlinesForUniqueness: Array.isArray(headlines_for_uniqueness)
          ? headlines_for_uniqueness.map((h: string) => String(h).trim()).filter(Boolean)
          : [],
        dailyBudget: Number(daily_budget || 0),
        maxCpc: Number(max_cpc || 0),
        biddingStrategy: bidding_strategy,
        aiRuleProfile: settings?.ai_rule_profile,
        adLanguageCode: ad_language,
      });
      newItems = result.filter((d) => !existingItems.includes(d));
    }

    const maxLen = type === "headlines" ? 30 : 90;
    const minLen = type === "headlines" ? 2 : 40;
    const autoFixed: string[] = [];
    const remaining: string[] = [];

    for (let attempt = 0; attempt < MAX_COMPLIANCE_RETRIES; attempt++) {
      const violations = checkItemViolations(newItems, settings?.ai_rule_profile);
      if (violations.length === 0) break;

      const avoidReasons = [...new Set(violations.flatMap((v) => v.reasons))];
      const prompt = `Generate ${violations.length} replacement Google Ads RSA ${type === "headlines" ? "headlines" : "descriptions"}.
Merchant: ${merchant_name || ""}, Language: ${languageName}

REJECTED items needing replacement:
${violations.map((v, i) => `${i + 1}. "${v.text}" — reason: ${v.reasons.join(", ")}`).join("\n")}

MUST AVOID: ${avoidReasons.join("; ")}
Never use these exact words: guaranteed, risk-free, zero risk, 100% safe, cure, cures, miracle, heal, heals, instant approval, before and after
Each item: ${minLen}-${maxLen} characters. Return ONLY a JSON array of ${violations.length} strings.`;

      try {
        const raw = await callAiWithFallback("ad_copy", [{ role: "user", content: prompt }], 1024);
        const parsed = JSON.parse(extractJsonFromAi(raw));
        if (Array.isArray(parsed)) {
          for (let i = 0; i < violations.length && i < parsed.length; i++) {
            const replacement = String(parsed[i] || "").trim();
            if (replacement.length >= minLen && replacement.length <= maxLen) {
              autoFixed.push(`「${violations[i].text}」→「${replacement}」`);
              newItems[violations[i].index] = replacement;
            }
          }
        }
      } catch {
        break;
      }
    }

    const finalViolations = checkItemViolations(newItems, settings?.ai_rule_profile);
    if (finalViolations.length > 0) {
      const removeIndices = new Set(finalViolations.map((v) => v.index));
      for (const v of finalViolations) {
        remaining.push(`${type === "headlines" ? "标题" : "描述"}「${v.text}」已删除（${v.reasons.join("、")}）`);
      }
      newItems = newItems.filter((_, idx) => !removeIndices.has(idx));
    }

    return apiSuccess({
      items: newItems,
      ...(autoFixed.length > 0 ? { compliance_auto_fix: autoFixed } : {}),
      ...(remaining.length > 0 ? { compliance_warnings: remaining } : {}),
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("[GenerateMore]", msg);
    return apiError(`AI 生成失败: ${msg.slice(0, 200)}`);
  }
}
