import { NextRequest } from "next/server";
import { getUserFromRequest, serializeData } from "@/lib/auth";
import { apiSuccess, apiError } from "@/lib/constants";
import prisma from "@/lib/prisma";
import { SemRushClient, parseDomainFromSemrushUrl } from "@/lib/semrush-client";
import { selectOptimizedKeywords } from "@/lib/ad-keyword-pipeline";

/**
 * POST /api/user/ad-creation/semrush-url
 * 通过 3UE SemRush 页面链接获取关键词
 */
export async function POST(req: NextRequest) {
  try {
    const user = getUserFromRequest(req);
    if (!user) return apiError("未授权", 401);

    const { url, country = "US", merchant_name = "", daily_budget, max_cpc, bidding_strategy } = await req.json();
    if (!url) return apiError("请输入 3UE SemRush 链接");

    const settings = await prisma.ad_default_settings.findFirst({
      where: { user_id: BigInt(user.userId), is_deleted: 0 },
      select: { ai_rule_profile: true },
    });

    const domain = parseDomainFromSemrushUrl(url);
    if (!domain) {
      return apiError("无法从链接中解析出域名，请确认链接格式正确（如 https://sem.3ue.co/analytics/overview/?q=...）");
    }

    const client = await SemRushClient.fromConfig(country);
    const result = await client.queryDomain(domain);
    const optimizedKeywords = selectOptimizedKeywords(result.keywords, {
      merchantName: merchant_name,
      dailyBudget: Number(daily_budget || 0),
      maxCpc: Number(max_cpc || 0),
      biddingStrategy: bidding_strategy,
      aiRuleProfile: settings?.ai_rule_profile,
      limit: 8,
    });
    return apiSuccess(serializeData({
      domain: result.domain,
      keywords: optimizedKeywords,
      raw_keywords: result.keywords,
      raw_keyword_count: result.keywords.length,
      deduped_titles: result.dedupedTitles,
      deduped_descriptions: result.dedupedDescriptions,
    }));
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn("[SemRush URL] 查询失败:", msg);
    return apiError(msg || "关键词获取失败，请稍后再试");
  }
}
