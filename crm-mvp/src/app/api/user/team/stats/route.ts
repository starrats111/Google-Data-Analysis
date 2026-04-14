import { NextRequest } from "next/server";
import { serializeData } from "@/lib/auth";
import { apiSuccess, apiError } from "@/lib/constants";
import { withLeader } from "@/lib/api-handler";
import prisma from "@/lib/prisma";
import { sqlAffiliateTxnValidPlatformConnection } from "@/lib/affiliate-transaction-sql";
import { nowCST, parseCSTDateStart, parseCSTDateEndExclusive, isTodayCST, dateColumnStart, dateColumnEndExclusive, dateColumnTodayEndExclusive } from "@/lib/date-utils";

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

  const cstNow = nowCST();
  const monthStartStr = cstNow.startOf("month").format("YYYY-MM-DD");
  const statsStart = startDate ? dateColumnStart(startDate) : dateColumnStart(monthStartStr);
  const statsEnd = endDate
    ? (isTodayCST(endDate, cstNow) ? dateColumnTodayEndExclusive() : dateColumnEndExclusive(endDate))
    : dateColumnTodayEndExclusive();
  const txnStart = startDate ? parseCSTDateStart(startDate) : cstNow.startOf("month").toDate();
  const txnEnd = endDate
    ? (isTodayCST(endDate, cstNow) ? cstNow.toDate() : parseCSTDateEndExclusive(endDate))
    : cstNow.toDate();

  // 查询所有组员的有效 campaigns（排除幽灵记录，统一去重）
  const rawCampaigns = await prisma.campaigns.findMany({
    where: {
      user_id: { in: memberIds },
      google_campaign_id: { not: null },
      is_deleted: 0,
    },
    orderBy: { id: "desc" },
    select: { id: true, user_id: true, customer_id: true, google_campaign_id: true },
  });

  // 按「成员 + Google Campaign ID」去重，优先保留有 customer_id 的记录
  const gcidGroups = new Map<string, typeof rawCampaigns>();
  for (const c of rawCampaigns) {
    const key = `${c.user_id}:${c.google_campaign_id || String(c.id)}`;
    if (!gcidGroups.has(key)) gcidGroups.set(key, []);
    gcidGroups.get(key)!.push(c);
  }
  const validCampaigns: typeof rawCampaigns = [];
  const extraIds: bigint[] = [];
  for (const [, group] of gcidGroups) {
    group.sort((a, b) => {
      if (a.customer_id && !b.customer_id) return -1;
      if (!a.customer_id && b.customer_id) return 1;
      return Number(b.id) - Number(a.id);
    });
    validCampaigns.push(group[0]);
    for (let i = 1; i < group.length; i++) extraIds.push(group[i].id);
  }

  // campaign_id → 主记录 campaign_id 映射（处理重复）
  const campIdToGcid = new Map<string, string>();
  for (const c of rawCampaigns) campIdToGcid.set(String(c.id), `${c.user_id}:${c.google_campaign_id || String(c.id)}`);
  const gcidToPrimary = new Map<string, string>();
  for (const c of validCampaigns) gcidToPrimary.set(`${c.user_id}:${c.google_campaign_id || String(c.id)}`, String(c.id));

  // 按用户分组 campaign_ids
  const userCampaignIds = new Map<string, bigint[]>();
  for (const c of validCampaigns) {
    const uid = String(c.user_id);
    if (!userCampaignIds.has(uid)) userCampaignIds.set(uid, []);
    userCampaignIds.get(uid)!.push(c.id);
  }

  const allCampaignIds = validCampaigns.map((c) => c.id);
  const allIdsForStats = [...allCampaignIds, ...extraIds];

  // 批量聚合 cost/clicks/impressions + 佣金（并行查询）
  const [rawStatsAgg, commissionAgg] = await Promise.all([
    allIdsForStats.length > 0
      ? prisma.ads_daily_stats.groupBy({
          by: ["campaign_id"],
          where: {
            campaign_id: { in: allIdsForStats },
            date: { gte: statsStart, lt: statsEnd },
            is_deleted: 0,
          } as never,
          _sum: { cost: true, clicks: true, impressions: true },
        })
      : [],
    memberIds.length > 0
      ? prisma.$queryRawUnsafe<
          { user_id: bigint; total_commission: number; rejected_commission: number }[]
        >(`
          SELECT
            user_id,
            SUM(CAST(commission_amount AS DECIMAL(12,2))) as total_commission,
            SUM(CASE WHEN status = 'rejected' THEN CAST(commission_amount AS DECIMAL(12,2)) ELSE 0 END) as rejected_commission
          FROM affiliate_transactions
          WHERE user_id IN (${memberIds.map(() => "?").join(",")}) AND is_deleted = 0
            AND transaction_time >= ? AND transaction_time < ?
            AND ${sqlAffiliateTxnValidPlatformConnection("affiliate_transactions")}
          GROUP BY user_id
        `, ...memberIds, txnStart, txnEnd)
      : [],
  ]);

  const statsAgg: typeof rawStatsAgg = [];
  const mergedStats = new Map<string, typeof rawStatsAgg[0]>();
  for (const s of rawStatsAgg) {
    const gcid = campIdToGcid.get(String(s.campaign_id));
    const primaryId = gcid ? gcidToPrimary.get(gcid) : String(s.campaign_id);
    const key = primaryId || String(s.campaign_id);
    const existing = mergedStats.get(key);
    if (!existing || Number(s._sum?.cost || 0) > Number(existing._sum?.cost || 0)) {
      mergedStats.set(key, { ...s, campaign_id: BigInt(key) });
    }
  }
  statsAgg.push(...mergedStats.values());

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
    const net = commission - rejected - cost;
    const roi = cost > 0 ? (net / cost) * 100 : 0;

    return {
      user_id: uid,
      username: member.username,
      display_name: member.display_name,
      cost: Math.round(cost * 100) / 100,
      commission: Math.round(commission * 100) / 100,
      rejected_commission: Math.round(rejected * 100) / 100,
      net_commission: Math.round(net * 100) / 100,
      roi: Math.round(roi * 10) / 10,
      clicks,
      impressions,
    };
  });

  memberStats.sort((a, b) => b.roi - a.roi);

  // team_stats 汇总数据由前端从 member_ranking 派生，此处仅返回 member_count
  // （包含无 campaign 数据的成员，前端无法从 member_ranking 获知）
  return apiSuccess(serializeData({
    team_stats: { member_count: members.length },
    member_ranking: memberStats,
  }));
});
