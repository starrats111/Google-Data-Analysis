import { NextRequest } from "next/server";
import { apiSuccess, apiError } from "@/lib/constants";
import { withLeader } from "@/lib/api-handler";
import prisma from "@/lib/prisma";
import {
  computePauseWindow, buildDailyRows, sumTotals, buildReviewScopeKey,
  PAUSE_SOURCE_LABELS, REVIEW_RECOMMENDATION_TYPE,
} from "@/lib/review-analysis";

export const dynamic = "force-dynamic";

/**
 * D-245 复盘分析眼睛弹窗数据：单系列「暂停前 7 天」逐日明细 + AI 复盘点评缓存
 *
 * GET /api/user/team/review-daily?campaignId=123
 * 仅组长可用，且系列必须归属本组成员（含组长本人）。
 */
export const GET = withLeader(async (req: NextRequest, { user }) => {
  if (!user.teamId) return apiError("未关联小组");
  const campaignIdRaw = req.nextUrl.searchParams.get("campaignId");
  if (!campaignIdRaw) return apiError("缺少 campaignId", 400);
  let campaignId: bigint;
  try {
    campaignId = BigInt(campaignIdRaw);
  } catch {
    return apiError("campaignId 格式无效", 400);
  }

  const campaign = await prisma.campaigns.findFirst({
    where: { id: campaignId, is_deleted: 0 },
    select: {
      id: true, user_id: true, customer_id: true, campaign_name: true,
      google_status: true, paused_at: true, pause_source: true, daily_budget: true,
    },
  });
  if (!campaign) return apiError("广告系列不存在", 404);

  // 越组按不存在处理，不泄露系列归属
  const owner = await prisma.users.findFirst({
    where: { id: campaign.user_id, team_id: BigInt(user.teamId), is_deleted: 0 },
    select: { username: true, display_name: true },
  });
  if (!owner) return apiError("广告系列不存在", 404);
  if (!campaign.paused_at) return apiError("该系列没有暂停记录，无法复盘", 400);

  const window = computePauseWindow(campaign.paused_at);
  const stats = await prisma.ads_daily_stats.findMany({
    where: {
      campaign_id: campaignId,
      is_deleted: 0,
      date: { gte: window.dateStart, lt: window.dateEndExclusive },
    },
    select: {
      date: true, impressions: true, clicks: true, cost: true,
      orders: true, commission: true, rejected_commission: true,
    },
    orderBy: { date: "asc" },
  });
  const daily = buildDailyRows(window, stats);

  // AI 复盘点评缓存（scope_key 带暂停日期，再次暂停自动换新）
  const cached = await prisma.ai_recommendations.findFirst({
    where: {
      campaign_id: campaignId,
      scope_key: buildReviewScopeKey(window.pauseDateStr),
      recommendation_type: REVIEW_RECOMMENDATION_TYPE,
      status: "active",
      is_deleted: 0,
    },
    select: { reason_summary: true, reason_detail: true, updated_at: true },
  });

  return apiSuccess({
    campaign: {
      id: String(campaign.id),
      name: campaign.campaign_name,
      customerId: campaign.customer_id,
      status: campaign.google_status,
      dailyBudget: Number(campaign.daily_budget || 0),
      pauseDate: window.pauseDateStr,
      pauseSource: campaign.pause_source,
      pauseSourceLabel: PAUSE_SOURCE_LABELS[campaign.pause_source || ""] || campaign.pause_source || "未知",
      owner: { username: owner.username, displayName: owner.display_name },
    },
    range: { start: window.startStr, end: window.endStr },
    daily,
    totals: sumTotals(daily),
    review: cached
      ? {
          summary: cached.reason_summary,
          detail: cached.reason_detail || "",
          updatedAt: cached.updated_at.toISOString(),
        }
      : null,
  });
});
