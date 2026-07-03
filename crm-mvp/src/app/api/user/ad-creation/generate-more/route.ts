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

  const { type, existing, merchant_name, country, count, keywords = [], headlines_for_uniqueness = [], daily_budget, max_cpc, bidding_strategy, ad_language, ad_creative_id } = await req.json();

  if (!type || !["headlines", "descriptions"].includes(type)) {
    return apiError("type 必须为 headlines 或 descriptions");
  }

  const existingItems = Array.isArray(existing) ? existing.filter((s: string) => s?.trim()) : [];
  const targetCount = Math.min(count || (type === "headlines" ? 15 : 4), type === "headlines" ? 15 : 4);
  const [settings, adCreative] = await Promise.all([
    prisma.ad_default_settings.findFirst({
      where: { user_id: BigInt(user.userId), is_deleted: 0 },
      select: { ai_rule_profile: true },
    }),
    ad_creative_id ? prisma.ad_creatives.findFirst({
      where: { id: Number(ad_creative_id) },
      select: { crawl_cache: true },
    }) : Promise.resolve(null),
  ]);

  // 从 crawl_cache 提取业务上下文，供 padHeadlines/padDescriptions 使用
  // D-025 R-1.A：之前 generate-more 只把 pageText/crawledProducts 给了 padDescriptions，
  //              padHeadlines 完全没传任何商家上下文 → 用户每次点"重新生成标题"都触发同样的退化
  const crawlCache = adCreative?.crawl_cache as Record<string, unknown> | null;
  const pageText = typeof crawlCache?.pageText === "string" ? crawlCache.pageText : "";
  const crawledProducts = Array.isArray(crawlCache?.crawledProducts) ? crawlCache.crawledProducts as Array<{ name: string; price?: number; currency?: string }> : [];
  const cachedFeatures = Array.isArray(crawlCache?.features) ? (crawlCache.features as unknown[]).filter((f): f is string => typeof f === "string") : [];
  const biz = (crawlCache?.businessSummary as { summary_en?: string; category_guess?: string } | null | undefined);
  const businessSummary = typeof biz?.summary_en === "string" ? biz.summary_en : null;
  const businessCategoryGuess = typeof biz?.category_guess === "string" ? biz.category_guess : null;

  // merchant_url / category 不在请求体里，需要按 ad_creative_id 反查 user_merchants
  let merchantUrlFromDb: string | undefined;
  let categoryFromDb: string | null | undefined;
  if (ad_creative_id) {
    try {
      const um = await prisma.$queryRaw<Array<{ merchant_url: string | null; category: string | null }>>`
        SELECT um.merchant_url, um.category
        FROM ad_creatives ac
        INNER JOIN ad_groups ag ON ag.id = ac.ad_group_id
        INNER JOIN campaigns c ON c.id = ag.campaign_id
        INNER JOIN user_merchants um ON um.id = c.user_merchant_id
        WHERE ac.id = ${Number(ad_creative_id)} LIMIT 1`;
      if (um[0]) {
        merchantUrlFromDb = um[0].merchant_url || undefined;
        categoryFromDb = um[0].category;
      }
    } catch { /* 反查失败不阻断生成，businessContextBlock 会按其它信号兜底 */ }
  }

  const sharedBusinessContext = {
    pageText: pageText || undefined,
    merchantUrl: merchantUrlFromDb,
    category: categoryFromDb,
    businessSummary,
    businessCategoryGuess,
    features: cachedFeatures.length > 0 ? cachedFeatures : undefined,
    crawledProducts: crawledProducts.length > 0 ? crawledProducts : undefined,
  } as const;

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
        ...sharedBusinessContext,
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
        ...sharedBusinessContext,
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
