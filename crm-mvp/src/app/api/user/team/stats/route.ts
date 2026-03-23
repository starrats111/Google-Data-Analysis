import { NextRequest } from "next/server";
import { serializeData } from "@/lib/auth";
import { apiSuccess, apiError } from "@/lib/constants";
import { withLeader } from "@/lib/api-handler";
import prisma from "@/lib/prisma";

/**
 * 获取小组统计数据（组长专用）
 * 查询逻辑与 /api/user/data-center/campaigns 保持一致：
 *   campaigns（排除幽灵、去重） → ads_daily_stats + affiliate_transactions
 */
export const GET = withLeader(async (req: NextRequest, { user }) => {
  const { searchParams } = new URL(req.url);
  const startDate = searchParams.get("start_date");
  const endDate = searchParams.get("end_date");

  if (!user.teamId) return apiError("未关联小组");

  const teamId = BigInt(user.teamId);

  const members = await prisma.users.findMany({
    where: { team_id: teamId, is_deleted: 0, role: "user" },
    select: { id: true, username: true, display_name: true, status: true },
  });

  if (members.length === 0) {
    return apiSuccess({
      team_stats: { member_count: 0, total_cost: 0, total_commission: 0, rejected_commission: 0, net_commission: 0, total_profit: 0, avg_roi: 0 },
      member_ranking: [],
    });
  }

  const memberIds = members.map((m) => m.id);

  const start = startDate ? new Date(startDate) : new Date();
  const end = endDate ? new Date(endDate) : new Date();
  const endPlusOne = new Date(end);
  endPlusOne.setDate(endPlusOne.getDate() + 1);

  // 查询所有组员的有效 campaigns（排除幽灵记录，统一去重）
  const rawCampaigns = await prisma.campaigns.findMany({
    where: {
      user_id: { in: memberIds },
      google_campaign_id: { not: null },
      is_deleted: 0,
    },
    select: { id: true, user_id: true, google_campaign_id: true },
  });

  // 按 google_campaign_id 去重
  const seenGoogleIds = new Set<string>();
  const validCampaigns = rawCampaigns.filter((c) => {
    const gid = c.google_campaign_id || String(c.id);
    if (seenGoogleIds.has(gid)) return false;
    seenGoogleIds.add(gid);
    return true;
  });

  // 按用户分组 campaign_ids
  const userCampaignIds = new Map<string, bigint[]>();
  for (const c of validCampaigns) {
    const uid = String(c.user_id);
    if (!userCampaignIds.has(uid)) userCampaignIds.set(uid, []);
    userCampaignIds.get(uid)!.push(c.id);
  }

  const allCampaignIds = validCampaigns.map((c) => c.id);

  // 批量聚合 cost/clicks/impressions（佣金统一从 affiliate_transactions 读取）
  const statsAgg = allCampaignIds.length > 0
    ? await prisma.ads_daily_stats.groupBy({
        by: ["campaign_id"],
        where: {
          campaign_id: { in: allCampaignIds },
          date: { gte: start, lte: end },
          is_deleted: 0,
        } as never,
        _sum: { cost: true, clicks: true, impressions: true },
      })
    : [];

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

  // 佣金+拒付统一从 affiliate_transactions 聚合（与数据中心口径一致，排除未关联交易）
  const commissionAgg = memberIds.length > 0
    ? await prisma.$queryRawUnsafe<
        { user_id: bigint; total_commission: number; rejected_commission: number }[]
      >(`
        SELECT
          user_id,
          SUM(CAST(commission_amount AS DECIMAL(12,2))) as total_commission,
          SUM(CASE WHEN status = 'rejected' THEN CAST(commission_amount AS DECIMAL(12,2)) ELSE 0 END) as rejected_commission
        FROM affiliate_transactions
        WHERE user_id IN (${memberIds.map(() => "?").join(",")}) AND is_deleted = 0
          AND transaction_time >= ? AND transaction_time < ?
          AND user_merchant_id != 0
        GROUP BY user_id
      `, ...memberIds, start, endPlusOne)
    : [];

  const commissionByUser = new Map<string, { commission: number; rejected: number }>();
  for (const r of commissionAgg) {
    commissionByUser.set(String(r.user_id), {
      commission: Number(r.total_commission || 0),
      rejected: Number(r.rejected_commission || 0),
    });
  }

  // 汇总每个成员的数据
  const memberStats = members.map((member) => {
    const uid = String(member.id);
    const cIds = userCampaignIds.get(uid) || [];

    let cost = 0, clicks = 0, impressions = 0;
    for (const cid of cIds) {
      const s = statsMap.get(String(cid));
      if (s) {
        cost += s.cost;
        clicks += s.clicks;
        impressions += s.impressions;
      }
    }

    const userComm = commissionByUser.get(uid);
    const commission = userComm?.commission || 0;
    const rejected = userComm?.rejected || 0;
    const net = commission - rejected;
    const profit = net - cost;
    const roi = cost > 0 ? ((commission - cost) / cost) * 100 : 0;

    return {
      user_id: uid,
      username: member.username,
      display_name: member.display_name,
      cost: Math.round(cost * 100) / 100,
      commission: Math.round(commission * 100) / 100,
      rejected_commission: Math.round(rejected * 100) / 100,
      net_commission: Math.round(net * 100) / 100,
      profit: Math.round(profit * 100) / 100,
      roi: Math.round(roi * 10) / 10,
      clicks,
      impressions,
    };
  });

  memberStats.sort((a, b) => b.roi - a.roi);

  const totalCost = memberStats.reduce((s, m) => s + m.cost, 0);
  const totalCommission = memberStats.reduce((s, m) => s + m.commission, 0);
  const totalRejected = memberStats.reduce((s, m) => s + m.rejected_commission, 0);
  const totalNet = totalCommission - totalRejected;
  const totalProfit = totalNet - totalCost;
  const avgRoi = totalCost > 0 ? ((totalCommission - totalCost) / totalCost) * 100 : 0;

  return apiSuccess(serializeData({
    team_stats: {
      member_count: members.length,
      total_cost: Math.round(totalCost * 100) / 100,
      total_commission: Math.round(totalCommission * 100) / 100,
      rejected_commission: Math.round(totalRejected * 100) / 100,
      net_commission: Math.round(totalNet * 100) / 100,
      total_profit: Math.round(totalProfit * 100) / 100,
      avg_roi: Math.round(avgRoi * 10) / 10,
    },
    member_ranking: memberStats,
  }));
});
