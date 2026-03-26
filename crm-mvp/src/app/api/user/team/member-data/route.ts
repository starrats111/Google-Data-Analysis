import { NextRequest } from "next/server";
import { serializeData } from "@/lib/auth";
import { apiSuccess, apiError } from "@/lib/constants";
import { withLeader } from "@/lib/api-handler";
import prisma from "@/lib/prisma";
import { nowCST, parseCSTDateStart, parseCSTDateEndExclusive, isTodayCST } from "@/lib/date-utils";

/**
 * 获取指定组员的详细数据（组长专用）
 * 查询逻辑与 /api/user/data-center/campaigns 保持一致：
 *   campaigns → ads_daily_stats + affiliate_transactions
 */
export const GET = withLeader(async (req: NextRequest, { user }) => {
  const { searchParams } = new URL(req.url);
  const targetUserId = searchParams.get("userId");
  const startDate = searchParams.get("start_date");
  const endDate = searchParams.get("end_date");

  if (!targetUserId) return apiError("缺少 userId 参数");
  if (!user.teamId) return apiError("未关联小组");

  const targetUser = await prisma.users.findFirst({
    where: { id: BigInt(targetUserId), team_id: BigInt(user.teamId), is_deleted: 0 },
    select: { id: true, username: true, display_name: true },
  });

  if (!targetUser) return apiError("该用户不属于您的小组", 403);

  const targetId = targetUser.id;

  // 日期范围
  const cstNow = nowCST();
  const start = startDate ? parseCSTDateStart(startDate) : cstNow.startOf("month").toDate();
  const endExclusive = endDate
    ? (isTodayCST(endDate, cstNow) ? cstNow.toDate() : parseCSTDateEndExclusive(endDate))
    : cstNow.toDate();

  // 与数据中心一致：先查 campaigns，过滤掉无 google_campaign_id 的幽灵记录
  const rawCampaigns = await prisma.campaigns.findMany({
    where: {
      user_id: targetId,
      google_campaign_id: { not: null },
      is_deleted: 0,
    },
    orderBy: { id: "desc" },
    select: {
      id: true,
      google_campaign_id: true,
      customer_id: true,
      campaign_name: true,
      google_status: true,
      user_merchant_id: true,
    },
  });

  // 与数据中心一致：按「CID + Google Campaign ID」去重，并优先保留最新一条
  const seenCampaignKeys = new Set<string>();
  const campaigns = rawCampaigns.filter((c) => {
    const dedupKey = `${c.customer_id || ""}:${c.google_campaign_id || String(c.id)}`;
    if (seenCampaignKeys.has(dedupKey)) return false;
    seenCampaignKeys.add(dedupKey);
    return true;
  });

  const campaignIds = campaigns.map((c) => c.id);

  if (campaignIds.length === 0) {
    return apiSuccess(serializeData({
      user: { id: targetUser.id.toString(), username: targetUser.username, display_name: targetUser.display_name },
      summary: emptySummary(),
      campaigns: [],
    }));
  }

  // 按 campaign_id 聚合 cost/clicks/impressions（佣金统一从 affiliate_transactions 读取）
  const statsAgg = await prisma.ads_daily_stats.groupBy({
    by: ["campaign_id"],
    where: {
      campaign_id: { in: campaignIds },
      date: { gte: start, lt: endExclusive },
      is_deleted: 0,
    } as never,
    _sum: { cost: true, clicks: true, impressions: true },
  });

  const statsMap = new Map(
    statsAgg.map((s) => [
      String(s.campaign_id),
      {
        cost: Number(s._sum?.cost || 0),
        clicks: Number(s._sum?.clicks || 0),
        impressions: Number(s._sum?.impressions || 0),
      },
    ])
  );

  // 佣金统一从 affiliate_transactions 聚合（与数据中心口径一致）
  const commissionAgg = await prisma.$queryRawUnsafe<
    { user_merchant_id: bigint; total_commission: number; rejected_commission: number; approved_commission: number; order_count: number }[]
  >(`
    SELECT
      user_merchant_id,
      SUM(CAST(commission_amount AS DECIMAL(12,2))) as total_commission,
      SUM(CASE WHEN status = 'rejected' THEN CAST(commission_amount AS DECIMAL(12,2)) ELSE 0 END) as rejected_commission,
      SUM(CASE WHEN status = 'approved' THEN CAST(commission_amount AS DECIMAL(12,2)) ELSE 0 END) as approved_commission,
      COUNT(*) as order_count
    FROM affiliate_transactions
    WHERE user_id = ? AND is_deleted = 0
      AND transaction_time >= ? AND transaction_time < ?
    GROUP BY user_merchant_id
  `, targetId, start, endExclusive);

  const commissionByMerchant = new Map<string, { commission: number; rejected: number; approved: number; orders: number }>();
  let totalCommissionFromTxn = 0;
  let totalRejectedFromTxn = 0;
  let totalOrdersFromTxn = 0;
  for (const r of commissionAgg) {
    const key = String(r.user_merchant_id);
    const comm = Number(r.total_commission || 0);
    const rej = Number(r.rejected_commission || 0);
    commissionByMerchant.set(key, {
      commission: comm,
      rejected: rej,
      approved: Number(r.approved_commission || 0),
      orders: Number(r.order_count || 0),
    });
    totalCommissionFromTxn += comm;
    totalRejectedFromTxn += rej;
    totalOrdersFromTxn += Number(r.order_count || 0);
  }

  const merchantWritten = new Set<string>();

  let totalCost = 0, totalClicks = 0, totalImpressions = 0;

  const campaignDetails = campaigns.map((c) => {
    const s = statsMap.get(String(c.id));
    const cost = s?.cost || 0;
    const clicks = s?.clicks || 0;
    const impressions = s?.impressions || 0;

    const merchantId = String(c.user_merchant_id);
    let commission = 0, rejectedComm = 0, orders = 0;
    if (merchantId && merchantId !== "0" && commissionByMerchant.has(merchantId) && !merchantWritten.has(merchantId)) {
      const comm = commissionByMerchant.get(merchantId)!;
      commission = comm.commission;
      rejectedComm = comm.rejected;
      orders = comm.orders;
      merchantWritten.add(merchantId);
    }

    const net = commission - rejectedComm - cost;
    const roi = cost > 0 ? (net / cost) * 100 : 0;

    totalCost += cost;
    totalClicks += clicks;
    totalImpressions += impressions;

    return {
      campaign_id: c.id.toString(),
      campaign_name: c.campaign_name || "未知",
      customer_id: c.customer_id || "",
      status: c.google_status || "",
      cost: Math.round(cost * 100) / 100,
      commission: Math.round(commission * 100) / 100,
      rejected_commission: Math.round(rejectedComm * 100) / 100,
      clicks,
      impressions,
      orders,
      roi: Math.round(roi * 10) / 10,
    };
  });

  campaignDetails.sort((a, b) => b.cost - a.cost);

  const avgCpc = totalClicks > 0 ? totalCost / totalClicks : 0;
  const totalNet = totalCommissionFromTxn - totalRejectedFromTxn - totalCost;
  const roi = totalCost > 0 ? (totalNet / totalCost) * 100 : 0;

  return apiSuccess(serializeData({
    user: { id: targetUser.id.toString(), username: targetUser.username, display_name: targetUser.display_name },
    summary: {
      total_cost: Math.round(totalCost * 100) / 100,
      total_commission: Math.round(totalCommissionFromTxn * 100) / 100,
      rejected_commission: Math.round(totalRejectedFromTxn * 100) / 100,
      net_commission: Math.round(totalNet * 100) / 100,
      total_clicks: totalClicks,
      total_impressions: totalImpressions,
      avg_cpc: Math.round(avgCpc * 10000) / 10000,
      roi: Math.round(roi * 10) / 10,
      total_orders: totalOrdersFromTxn,
    },
    campaigns: campaignDetails,
  }));
});

function emptySummary() {
  return {
    total_cost: 0, total_commission: 0, rejected_commission: 0, net_commission: 0,
    total_clicks: 0, total_impressions: 0, avg_cpc: 0, roi: 0, total_orders: 0,
  };
}
