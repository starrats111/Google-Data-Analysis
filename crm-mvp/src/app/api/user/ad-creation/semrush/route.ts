import { NextRequest } from "next/server";
import { getUserFromRequest, serializeData } from "@/lib/auth";
import { apiSuccess, apiError } from "@/lib/constants";
import prisma from "@/lib/prisma";
import { SemRushClient } from "@/lib/semrush-client";
import { selectOptimizedKeywords } from "@/lib/ad-keyword-pipeline";

/**
 * POST /api/user/ad-creation/semrush
 * 获取 SemRush 竞品数据（标题/描述/关键词）
 */
export async function POST(req: NextRequest) {
  try {
    const user = getUserFromRequest(req);
    if (!user) return apiError("未授权", 401);

    const { merchant_url, country = "US", merchant_name = "", daily_budget, max_cpc, bidding_strategy } = await req.json();
    if (!merchant_url) return apiError("缺少商家 URL");

    const settings = await prisma.ad_default_settings.findFirst({
      where: { user_id: BigInt(user.userId), is_deleted: 0 },
      select: { ai_rule_profile: true },
    });

    const client = await SemRushClient.fromConfig(country);
    const result = await client.queryDomain(merchant_url);
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
      deduped_titles: result.dedupedTitles,
      deduped_descriptions: result.dedupedDescriptions,
      keywords: optimizedKeywords,
      raw_keywords: result.keywords,
      raw_keyword_count: result.keywords.length,
      total_copies: result.copies.total,
      creative_samples_count: result.creativeSamples.length,
    }));
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("[SemRush API]", msg);
    if (msg.includes("凭据未配置")) {
      return apiError("SemRush 功能未配置，请联系管理员在后台设置 SemRush/3UE 凭据");
    }
    return apiError(msg || "SemRush 查询失败，请稍后再试");
  }
}
