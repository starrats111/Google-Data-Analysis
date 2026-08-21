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

import { resolveCampaignReadScopes } from "@/lib/campaign-read-access";

/**
 * D-238 眼睛弹窗数据：单系列最近 7 天逐日明细 + 最新 AI 分析报告
 *
 * GET ?campaignId=123&strategy=balanced
 * D-241：组长可只读本组组员的系列（逐日明细与缓存建议按归属人查询）
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

  // D-241：本人或组长（本组组员）可读；越域按不存在处理，不泄露系列归属
  const scopes = await resolveCampaignReadScopes(user, [campaignId]);
  if (!scopes || scopes.size === 0) return apiError("广告系列不存在", 404);
  const ownerId = BigInt([...scopes.keys()][0]);

  const campaign = await prisma.campaigns.findFirst({
    where: { id: campaignId, user_id: ownerId, is_deleted: 0 },
    select: { id: true, campaign_name: true, daily_budget: true, max_cpc_limit: true, google_status: true, mcc_id: true },
  });
  if (!campaign) return apiError("广告系列不存在", 404);

  // D-266 批一：campaigns 存账户币种，弹窗展示折美元
  const { getCampaignUsdRates } = await import("@/lib/campaign-analysis");
  const usdRate = (await getCampaignUsdRates([campaign])).get(String(campaign.id)) ?? 1;

  const range = getAnalysisRange(7);
  const [dailyStats, recommendations] = await Promise.all([
    fetchCampaignDailyStats(ownerId, [campaignId], range),
    getCachedRecommendations(ownerId, [campaignId], strategy),
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
      dailyBudget: Number((Number(campaign.daily_budget || 0) * usdRate).toFixed(2)),
      maxCpc: campaign.max_cpc_limit ? Number((Number(campaign.max_cpc_limit) * usdRate).toFixed(4)) : null,
      status: campaign.google_status,
    },
    range: { start: range.startStr, end: range.endStr },
    daily,
    analysis: recommendations[0] || null,
  });
}
