import { NextRequest } from "next/server";
import { serializeData } from "@/lib/auth";
import { apiSuccess, apiError } from "@/lib/constants";
import { withUser } from "@/lib/api-handler";
import prisma from "@/lib/prisma";

/**
 * GET /api/user/merchants/active-advertisers?merchant_id=xxx&platform=YY
 *
 * 返回某商家的在投人员明细：
 * - 员工名、广告系列数、本月总花费、点击、展示、本月佣金
 */
export const GET = withUser(async (req: NextRequest) => {
  const { searchParams } = new URL(req.url);
  const merchantId = searchParams.get("merchant_id") || "";
  const platform = searchParams.get("platform") || "";

  if (!merchantId) return apiError("缺少 merchant_id");

  // 找到所有用户的 user_merchants 中同一个 merchant_id + platform
  const where: Record<string, unknown> = {
    merchant_id: merchantId,
    is_deleted: 0,
    status: "claimed",
  };
  if (platform) where.platform = platform;

  const allUserMerchants = await prisma.user_merchants.findMany({
    where: where as never,
    select: { id: true, user_id: true },
  });

  if (allUserMerchants.length === 0) {
    return apiSuccess(serializeData([]));
  }

  const umIds = allUserMerchants.map((um) => um.id);
  const userIdMap = new Map(allUserMerchants.map((um) => [um.id, um.user_id]));

  // 查找关联的 campaigns（启用状态），按 google_campaign_id 去重
  const rawCampaigns = await prisma.campaigns.findMany({
    where: {
      user_merchant_id: { in: umIds },
      is_deleted: 0,
    },
    select: {
      id: true,
      user_id: true,
      user_merchant_id: true,
      campaign_name: true,
      google_status: true,
      google_campaign_id: true,
      customer_id: true,
    },
    orderBy: { id: "desc" },
  });

  // 按 user_id + google_campaign_id 去重（防止重复 campaign 导致花费重复计算）
  const seenKeys = new Set<string>();
  const campaigns = rawCampaigns.filter((c) => {
    const gcid = c.google_campaign_id || String(c.id);
    const key = `${c.user_id}:${gcid}`;
    if (seenKeys.has(key)) return false;
    seenKeys.add(key);
    return true;
  });

  // 按 user_id 聚合
  const userCampaignMap = new Map<string, {
    userId: bigint;
    campaignIds: bigint[];
    campaignCount: number;
    enabledCount: number;
  }>();

  for (const c of campaigns) {
    const key = c.user_id.toString();
    if (!userCampaignMap.has(key)) {
      userCampaignMap.set(key, {
        userId: c.user_id,
        campaignIds: [],
        campaignCount: 0,
        enabledCount: 0,
      });
    }
    const entry = userCampaignMap.get(key)!;
    entry.campaignIds.push(c.id);
    entry.campaignCount++;
    if (c.google_status === "ENABLED") entry.enabledCount++;
  }

  // 只返回有至少一个启用广告的用户
  const activeUserIds = Array.from(userCampaignMap.values())
    .filter((e) => e.enabledCount > 0);

  if (activeUserIds.length === 0) {
    return apiSuccess(serializeData([]));
  }

  // 查用户名
  const users = await prisma.users.findMany({
    where: { id: { in: activeUserIds.map((e) => e.userId) } },
    select: { id: true, username: true, display_name: true },
  });
  const userNameMap = new Map(users.map((u) => [u.id.toString(), u.display_name || u.username]));

  // 本月统计数据
  const now = new Date();
  const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);
  const nextMonth = new Date(now.getFullYear(), now.getMonth() + 1, 1);

  const allCampaignIds = activeUserIds.flatMap((e) => e.campaignIds);

  // cost/clicks/impressions 从 ads_daily_stats 聚合
  const monthlyStats = await prisma.ads_daily_stats.groupBy({
    by: ["campaign_id"],
    where: {
      campaign_id: { in: allCampaignIds },
      date: { gte: monthStart },
      is_deleted: 0,
    },
    _sum: {
      cost: true,
      clicks: true,
      impressions: true,
    },
  });

  const statsMap = new Map(monthlyStats.map((s) => [
    s.campaign_id.toString(),
    {
      cost: Number(s._sum.cost || 0),
      clicks: Number(s._sum.clicks || 0),
      impressions: Number(s._sum.impressions || 0),
    },
  ]));

  // 佣金从 affiliate_transactions 聚合（半开区间处理 DATETIME 类型）
  const commissionAgg = umIds.length > 0
    ? await prisma.$queryRawUnsafe<
        { user_merchant_id: bigint; user_id: bigint; total_commission: number; rejected_commission: number }[]
      >(`
        SELECT
          user_merchant_id, user_id,
          SUM(CAST(commission_amount AS DECIMAL(12,2))) as total_commission,
          SUM(CASE WHEN status = 'rejected' THEN CAST(commission_amount AS DECIMAL(12,2)) ELSE 0 END) as rejected_commission
        FROM affiliate_transactions
        WHERE user_merchant_id IN (${umIds.map(() => "?").join(",")}) AND is_deleted = 0
          AND transaction_time >= ? AND transaction_time < ?
          AND user_merchant_id != 0
        GROUP BY user_merchant_id, user_id
      `, ...umIds, monthStart, nextMonth)
    : [];

  const commissionByUserMerchant = new Map<string, { total: number; rejected: number }>();
  for (const r of commissionAgg) {
    const key = `${r.user_id}_${r.user_merchant_id}`;
    commissionByUserMerchant.set(key, {
      total: Number(r.total_commission || 0),
      rejected: Number(r.rejected_commission || 0),
    });
  }

  // 汇总每个用户
  const result = activeUserIds.map((entry) => {
    let totalCost = 0, totalClicks = 0, totalImpressions = 0;
    for (const cid of entry.campaignIds) {
      const s = statsMap.get(cid.toString());
      if (s) {
        totalCost += s.cost;
        totalClicks += s.clicks;
        totalImpressions += s.impressions;
      }
    }

    let totalCommission = 0;
    let totalRejected = 0;
    for (const umId of umIds) {
      const userId = userIdMap.get(umId);
      if (userId && userId === entry.userId) {
        const c = commissionByUserMerchant.get(`${userId}_${umId}`);
        if (c) {
          totalCommission += c.total;
          totalRejected += c.rejected;
        }
      }
    }
    const netCommission = totalCommission - totalRejected;

    return {
      user_id: entry.userId,
      display_name: userNameMap.get(entry.userId.toString()) || "未知",
      campaign_count: entry.campaignCount,
      enabled_count: entry.enabledCount,
      total_cost: totalCost.toFixed(2),
      total_clicks: totalClicks,
      total_impressions: totalImpressions,
      monthly_commission: totalCommission.toFixed(2),
      roi: totalCost > 0 ? ((netCommission - totalCost) / totalCost).toFixed(2) : "0.00",
    };
  });

  return apiSuccess(serializeData(result));
});
