import { NextRequest } from "next/server";
import { getUserFromRequest } from "@/lib/auth";
import { apiSuccess, apiError } from "@/lib/constants";
import prisma from "@/lib/prisma";
import {
  fetchCampaignDailyStats,
  getAnalysisRange,
  getCachedRecommendations,
  isValidAnalysisStrategy,
  type AnalysisStrategy,
} from "@/lib/campaign-analysis";

export const dynamic = "force-dynamic";

/**
 * D-238 眼睛弹窗数据：单系列最近 7 天逐日明细 + 最新 AI 分析报告
 *
 * GET ?campaignId=123&strategy=balanced
 */
export async function GET(req: NextRequest) {
  const user = getUserFromRequest(req);
  if (!user) return apiError("未授权", 401);

  const campaignIdRaw = req.nextUrl.searchParams.get("campaignId");
  if (!campaignIdRaw) return apiError("缺少 campaignId", 400);
  let campaignId: bigint;
  try {
    campaignId = BigInt(campaignIdRaw);
  } catch {
    return apiError("campaignId 格式无效", 400);
  }
  const strategyParam = req.nextUrl.searchParams.get("strategy");
  const strategy: AnalysisStrategy = isValidAnalysisStrategy(strategyParam) ? strategyParam : "balanced";

  const userId = BigInt(user.userId);
  const campaign = await prisma.campaigns.findFirst({
    where: { id: campaignId, user_id: userId, is_deleted: 0 },
    select: { id: true, campaign_name: true, daily_budget: true, max_cpc_limit: true, google_status: true },
  });
  if (!campaign) return apiError("广告系列不存在", 404);

  const range = getAnalysisRange(7);
  const [dailyStats, recommendations] = await Promise.all([
    fetchCampaignDailyStats(userId, [campaignId], range),
    getCachedRecommendations(userId, [campaignId], strategy),
  ]);

  const daily = dailyStats.map((d) => ({
    date: d.statDate.toISOString().slice(0, 10),
    impressions: d.impressions,
    clicks: d.clicks,
    spend: Number(d.spend.toFixed(2)),
    orders: d.orders,
    commission: Number(d.commission.toFixed(2)),
    avgCpc: d.clicks > 0 ? Number((d.spend / d.clicks).toFixed(4)) : 0,
    maxCpc: Number(d.maxCpc.toFixed(2)),
    isBudget: d.isBudget,
    isRank: d.isRank,
    qualityScore: d.qualityScore || null,
    roi: d.spend > 0 ? Number(((d.commission - d.spend) / d.spend).toFixed(2)) : null,
  }));

  return apiSuccess({
    campaign: {
      id: String(campaign.id),
      name: campaign.campaign_name,
      dailyBudget: Number(campaign.daily_budget || 0),
      maxCpc: campaign.max_cpc_limit ? Number(campaign.max_cpc_limit) : null,
      status: campaign.google_status,
    },
    range: { start: range.startStr, end: range.endStr },
    daily,
    analysis: recommendations[0] || null,
  });
}
