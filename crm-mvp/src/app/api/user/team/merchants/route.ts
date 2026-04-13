import { NextRequest } from "next/server";
import { serializeData } from "@/lib/auth";
import { apiSuccess, apiError } from "@/lib/constants";
import { withLeader } from "@/lib/api-handler";
import prisma from "@/lib/prisma";
import { sqlAffiliateTxnValidPlatformConnection } from "@/lib/affiliate-transaction-sql";
import { nowCST, parseCSTDateStart, dateColumnStart } from "@/lib/date-utils";

/**
 * GET /api/user/team/merchants?page=1&pageSize=50&search=xxx&platform=CG
 *
 * 组长专用：查询组内所有成员领取的商家，按商家聚合
 * 返回：商家名称、平台、MID、主营业务、在投人数、本月佣金合计、ROI
 */
export const GET = withLeader(async (req: NextRequest, { user }) => {
  const { searchParams } = new URL(req.url);
  const page = Math.max(1, parseInt(searchParams.get("page") || "1", 10));
  const pageSize = Math.min(100, Math.max(1, parseInt(searchParams.get("pageSize") || "50", 10)));
  const search = (searchParams.get("search") || "").trim();
  const platform = (searchParams.get("platform") || "").trim();

  if (!user.teamId) return apiError("未关联小组");

  const teamId = BigInt(user.teamId);

  // 查询组内所有成员 ID
  const members = await prisma.users.findMany({
    where: { team_id: teamId, is_deleted: 0, role: "user" },
    select: { id: true },
  });

  if (members.length === 0) {
    return apiSuccess(serializeData({ merchants: [], total: 0, page, pageSize }));
  }

  const memberIds = members.map((m) => m.id);

  // 查询所有成员的已领取商家
  const umWhere: Record<string, unknown> = {
    user_id: { in: memberIds },
    is_deleted: 0,
    status: { in: ["claimed", "paused"] },
  };
  if (platform) umWhere.platform = platform;

  const allUserMerchants = await prisma.user_merchants.findMany({
    where: umWhere as never,
    select: {
      id: true,
      user_id: true,
      merchant_id: true,
      platform: true,
      merchant_name: true,
      merchant_url: true,
      category: true,
      status: true,
    },
    orderBy: { claimed_at: "desc" },
  });

  if (allUserMerchants.length === 0) {
    return apiSuccess(serializeData({ merchants: [], total: 0, page, pageSize }));
  }

  // 按 merchant_id + platform 聚合，去重 user_merchants
  const merchantKeyMap = new Map<string, {
    merchant_id: string;
    platform: string;
    merchant_name: string;
    merchant_url: string | null;
    category: string | null;
    umIds: bigint[];
    userIds: Set<string>;
  }>();

  for (const um of allUserMerchants) {
    const key = `${um.merchant_id}:${um.platform}`;
    if (!merchantKeyMap.has(key)) {
      merchantKeyMap.set(key, {
        merchant_id: um.merchant_id,
        platform: um.platform,
        merchant_name: um.merchant_name,
        merchant_url: um.merchant_url,
        category: um.category,
        umIds: [],
        userIds: new Set(),
      });
    }
    const entry = merchantKeyMap.get(key)!;
    entry.umIds.push(um.id);
    entry.userIds.add(um.user_id.toString());
  }

  // 搜索过滤（商家名称 / MID）
  let merchantEntries = Array.from(merchantKeyMap.values());
  if (search) {
    const lower = search.toLowerCase();
    merchantEntries = merchantEntries.filter(
      (e) => e.merchant_name.toLowerCase().includes(lower) || e.merchant_id.toLowerCase().includes(lower)
    );
  }

  const total = merchantEntries.length;
  const pagedEntries = merchantEntries.slice((page - 1) * pageSize, page * pageSize);

  if (pagedEntries.length === 0) {
    return apiSuccess(serializeData({ merchants: [], total, page, pageSize }));
  }

  const pagedUmIds = pagedEntries.flatMap((e) => e.umIds);

  // 本月时间范围
  const cstNow = nowCST();
  const monthStartStr = cstNow.startOf("month").format("YYYY-MM-DD");
  const nextMonthStr = cstNow.startOf("month").add(1, "month").format("YYYY-MM-DD");
  const statsMonthStart = dateColumnStart(monthStartStr);
  const statsNextMonth = dateColumnStart(nextMonthStr);
  const txnMonthStart = parseCSTDateStart(monthStartStr);
  const txnNextMonth = parseCSTDateStart(nextMonthStr);

  // 查询启用中的 campaigns（用于统计在投人数）
  const rawCampaigns = await prisma.campaigns.findMany({
    where: {
      user_merchant_id: { in: pagedUmIds },
      is_deleted: 0,
      google_status: "ENABLED",
    },
    select: { id: true, user_id: true, user_merchant_id: true, google_campaign_id: true, customer_id: true },
    orderBy: { id: "desc" },
  });

  // 去重（防止重复 campaign）
  const seenKeys = new Set<string>();
  const campaigns = rawCampaigns.filter((c) => {
    const gcid = c.google_campaign_id || String(c.id);
    const key = `${c.user_id}:${gcid}`;
    if (seenKeys.has(key)) return false;
    seenKeys.add(key);
    return true;
  });

  // 按 user_merchant_id 聚合在投用户数
  const activeUsersByUm = new Map<string, Set<string>>();
  for (const c of campaigns) {
    const umKey = c.user_merchant_id.toString();
    if (!activeUsersByUm.has(umKey)) activeUsersByUm.set(umKey, new Set());
    activeUsersByUm.get(umKey)!.add(c.user_id.toString());
  }

  // 佣金聚合（按 user_merchant_id）
  const commissionAgg = pagedUmIds.length > 0
    ? await prisma.$queryRawUnsafe<
        { user_merchant_id: bigint; total_commission: number; rejected_commission: number }[]
      >(`
        SELECT
          user_merchant_id,
          SUM(CAST(commission_amount AS DECIMAL(12,2))) as total_commission,
          SUM(CASE WHEN status = 'rejected' THEN CAST(commission_amount AS DECIMAL(12,2)) ELSE 0 END) as rejected_commission
        FROM affiliate_transactions
        WHERE user_merchant_id IN (${pagedUmIds.map(() => "?").join(",")}) AND is_deleted = 0
          AND transaction_time >= ? AND transaction_time < ?
          AND user_merchant_id != 0
          AND ${sqlAffiliateTxnValidPlatformConnection("affiliate_transactions")}
        GROUP BY user_merchant_id
      `, ...pagedUmIds, txnMonthStart, txnNextMonth)
    : [];

  const commByUm = new Map<string, { total: number; rejected: number }>();
  for (const r of commissionAgg) {
    commByUm.set(r.user_merchant_id.toString(), {
      total: Number(r.total_commission || 0),
      rejected: Number(r.rejected_commission || 0),
    });
  }

  // cost 聚合（按 user_merchant_id → campaign_id）
  const allCampaignIds = campaigns.map((c) => c.id);
  const campaignToUm = new Map<string, string>();
  for (const c of campaigns) campaignToUm.set(c.id.toString(), c.user_merchant_id.toString());

  const statsAgg = allCampaignIds.length > 0
    ? await prisma.ads_daily_stats.groupBy({
        by: ["campaign_id"],
        where: {
          campaign_id: { in: allCampaignIds },
          date: { gte: statsMonthStart, lt: statsNextMonth },
          is_deleted: 0,
        },
        _sum: { cost: true },
      })
    : [];

  const costByUm = new Map<string, number>();
  for (const s of statsAgg) {
    const umKey = campaignToUm.get(s.campaign_id.toString());
    if (!umKey) continue;
    costByUm.set(umKey, (costByUm.get(umKey) || 0) + Number(s._sum.cost || 0));
  }

  // 组装最终结果
  const merchants = pagedEntries.map((entry) => {
    let totalCommission = 0;
    let totalRejected = 0;
    let totalCost = 0;
    let activeUserSet = new Set<string>();

    for (const umId of entry.umIds) {
      const umKey = umId.toString();
      const comm = commByUm.get(umKey);
      if (comm) {
        totalCommission += comm.total;
        totalRejected += comm.rejected;
      }
      totalCost += costByUm.get(umKey) || 0;
      const activeUsers = activeUsersByUm.get(umKey);
      if (activeUsers) {
        for (const uid of activeUsers) activeUserSet.add(uid);
      }
    }

    const netCommission = totalCommission - totalRejected;
    const roi = totalCost > 0 ? ((netCommission - totalCost) / totalCost) * 100 : 0;

    return {
      key: `${entry.merchant_id}:${entry.platform}`,
      merchant_id: entry.merchant_id,
      platform: entry.platform,
      merchant_name: entry.merchant_name,
      merchant_url: entry.merchant_url,
      category: entry.category,
      active_advertisers: activeUserSet.size,
      monthly_commission: Math.round(totalCommission * 100) / 100,
      roi: Math.round(roi * 10) / 10,
      total_cost: Math.round(totalCost * 100) / 100,
    };
  });

  return apiSuccess(serializeData({ merchants, total, page, pageSize }));
});
