import { NextRequest } from "next/server";
import { serializeData } from "@/lib/auth";
import { apiSuccess, apiError } from "@/lib/constants";
import { withLeader } from "@/lib/api-handler";
import prisma from "@/lib/prisma";
import { sqlAffiliateTxnValidPlatformConnection } from "@/lib/affiliate-transaction-sql";
import { nowCST, parseCSTDateStart, dateColumnStart } from "@/lib/date-utils";

/**
 * GET /api/user/team/merchants?page=1&pageSize=50&search=xxx&platform=CG&sortField=monthly_commission&sortOrder=desc
 *
 * 组长专用：查询组内所有成员领取的商家，按商家聚合
 * 佣金先全量计算，服务端排序后再分页，确保排名准确
 */
export const GET = withLeader(async (req: NextRequest, { user }) => {
  const { searchParams } = new URL(req.url);
  const page = Math.max(1, parseInt(searchParams.get("page") || "1", 10));
  const pageSize = Math.min(100, Math.max(1, parseInt(searchParams.get("pageSize") || "50", 10)));
  const search = (searchParams.get("search") || "").trim();
  const platform = (searchParams.get("platform") || "").trim();
  const sortField = searchParams.get("sortField") || "monthly_commission";
  const sortOrder = searchParams.get("sortOrder") || "desc"; // asc | desc

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
    },
  });

  if (allUserMerchants.length === 0) {
    return apiSuccess(serializeData({ merchants: [], total: 0, page, pageSize }));
  }

  // 按 merchant_id + platform 聚合，去重
  const merchantKeyMap = new Map<string, {
    merchant_id: string;
    platform: string;
    merchant_name: string;
    merchant_url: string | null;
    category: string | null;
    umIds: bigint[];
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
      });
    }
    merchantKeyMap.get(key)!.umIds.push(um.id);
  }

  // 搜索过滤
  let merchantEntries = Array.from(merchantKeyMap.values());
  if (search) {
    const lower = search.toLowerCase();
    merchantEntries = merchantEntries.filter(
      (e) => e.merchant_name.toLowerCase().includes(lower) || e.merchant_id.toLowerCase().includes(lower)
    );
  }

  if (merchantEntries.length === 0) {
    return apiSuccess(serializeData({ merchants: [], total: 0, page, pageSize }));
  }

  // 本月时间范围
  const cstNow = nowCST();
  const monthStartStr = cstNow.startOf("month").format("YYYY-MM-DD");
  const nextMonthStr = cstNow.startOf("month").add(1, "month").format("YYYY-MM-DD");
  const statsMonthStart = dateColumnStart(monthStartStr);
  const statsNextMonth = dateColumnStart(nextMonthStr);
  const txnMonthStart = parseCSTDateStart(monthStartStr);
  const txnNextMonth = parseCSTDateStart(nextMonthStr);

  // ─── 第一步：全量查询 campaigns（所有商家，用于在投人数 + 后续花费）───
  const allUmIds = merchantEntries.flatMap((e) => e.umIds);

  // 全量 campaigns（ENABLED + PAUSED，不分页）
  // customer_id IS NOT NULL 过滤草稿广告（DRAFT-），只统计真实在 Google Ads 中运行的广告系列
  const rawAllCampaignsGlobal = await prisma.campaigns.findMany({
    where: {
      user_merchant_id: { in: allUmIds },
      is_deleted: 0,
      google_status: { not: "REMOVED" },
      customer_id: { not: null },
    },
    select: { id: true, user_id: true, user_merchant_id: true, google_campaign_id: true, customer_id: true, google_status: true },
    orderBy: { id: "desc" },
  });

  // 按 user_id + google_campaign_id 去重
  const gcidGroupsGlobal = new Map<string, typeof rawAllCampaignsGlobal>();
  for (const c of rawAllCampaignsGlobal) {
    const key = `${c.user_id}:${c.google_campaign_id || String(c.id)}`;
    if (!gcidGroupsGlobal.has(key)) gcidGroupsGlobal.set(key, []);
    gcidGroupsGlobal.get(key)!.push(c);
  }
  const allCampaignsGlobal: typeof rawAllCampaignsGlobal = [];
  for (const [, group] of gcidGroupsGlobal) {
    group.sort((a, b) => {
      if (a.customer_id && !b.customer_id) return -1;
      if (!a.customer_id && b.customer_id) return 1;
      return Number(b.id) - Number(a.id);
    });
    allCampaignsGlobal.push(group[0]);
  }

  // 全局在投人数：每个 user_merchant_id → 有几个不同用户在 ENABLED 投放
  const activeUsersByUmGlobal = new Map<string, Set<string>>();
  for (const c of allCampaignsGlobal) {
    if (c.google_status !== "ENABLED") continue;
    const umKey = c.user_merchant_id.toString();
    if (!activeUsersByUmGlobal.has(umKey)) activeUsersByUmGlobal.set(umKey, new Set());
    activeUsersByUmGlobal.get(umKey)!.add(c.user_id.toString());
  }

  const commissionAgg = await prisma.$queryRawUnsafe<
    { user_merchant_id: bigint; total_commission: number; rejected_commission: number }[]
  >(`
    SELECT
      user_merchant_id,
      SUM(CAST(commission_amount AS DECIMAL(12,2))) as total_commission,
      SUM(CASE WHEN status = 'rejected' THEN CAST(commission_amount AS DECIMAL(12,2)) ELSE 0 END) as rejected_commission
    FROM affiliate_transactions
    WHERE user_merchant_id IN (${allUmIds.map(() => "?").join(",")}) AND is_deleted = 0
      AND transaction_time >= ? AND transaction_time < ?
      AND user_merchant_id != 0
      AND ${sqlAffiliateTxnValidPlatformConnection("affiliate_transactions")}
    GROUP BY user_merchant_id
  `, ...allUmIds, txnMonthStart, txnNextMonth);

  const commByUm = new Map<string, { total: number; rejected: number }>();
  for (const r of commissionAgg) {
    commByUm.set(r.user_merchant_id.toString(), {
      total: Number(r.total_commission || 0),
      rejected: Number(r.rejected_commission || 0),
    });
  }

  // 为每个商家计算佣金 + 在投人数（用于排序）
  type MerchantWithComm = (typeof merchantEntries)[0] & {
    monthly_commission: number;
    net_commission: number;
    active_advertisers: number;
  };
  const entriesWithComm: MerchantWithComm[] = merchantEntries.map((entry) => {
    let totalCommission = 0;
    let totalRejected = 0;
    const activeUserSet = new Set<string>();
    for (const umId of entry.umIds) {
      const umKey = umId.toString();
      const c = commByUm.get(umKey);
      if (c) { totalCommission += c.total; totalRejected += c.rejected; }
      const activeUsers = activeUsersByUmGlobal.get(umKey);
      if (activeUsers) { for (const uid of activeUsers) activeUserSet.add(uid); }
    }
    return {
      ...entry,
      monthly_commission: Math.round(totalCommission * 100) / 100,
      net_commission: Math.round((totalCommission - totalRejected) * 100) / 100,
      active_advertisers: activeUserSet.size,
    };
  });

  // ─── 第二步：只保留有人在投的商家 ───
  const activeEntries = entriesWithComm.filter((e) => e.active_advertisers > 0);

  // ─── 第三步：服务端排序（支持 monthly_commission / active_advertisers）───
  const validSortFields = ["monthly_commission", "active_advertisers"];
  const field = validSortFields.includes(sortField) ? sortField : "monthly_commission";
  activeEntries.sort((a, b) => {
    const diff = (a[field as keyof MerchantWithComm] as number) - (b[field as keyof MerchantWithComm] as number);
    return sortOrder === "asc" ? diff : -diff;
  });

  const total = activeEntries.length;

  // ─── 第四步：分页 ───
  const pagedEntries = activeEntries.slice((page - 1) * pageSize, page * pageSize);

  if (pagedEntries.length === 0) {
    return apiSuccess(serializeData({ merchants: [], total, page, pageSize }));
  }

  const pagedUmIds = pagedEntries.flatMap((e) => e.umIds);

  // ─── 第五步：仅对当前页计算花费（用于 ROI 展示）───
  // campaigns 数据复用全局查询结果，过滤出当前页的 um_ids
  const pagedUmIdSet = new Set(pagedUmIds.map((id) => id.toString()));
  const pagedCampaigns = allCampaignsGlobal.filter((c) => pagedUmIdSet.has(c.user_merchant_id.toString()));
  const pagedRawCampaigns = rawAllCampaignsGlobal.filter((c) => pagedUmIdSet.has(c.user_merchant_id.toString()));

  // 当前页主记录 ID
  const pagedPrimaryCampaignIds = pagedCampaigns.map((c) => c.id);
  // 当前页重复记录 ID（用于花费合并）
  const pagedGcidToPrimary = new Map<string, string>();
  for (const c of pagedCampaigns) {
    pagedGcidToPrimary.set(`${c.user_id}:${c.google_campaign_id || String(c.id)}`, c.id.toString());
  }
  const pagedDupToGcid = new Map<string, string>();
  for (const c of pagedRawCampaigns) {
    pagedDupToGcid.set(c.id.toString(), `${c.user_id}:${c.google_campaign_id || String(c.id)}`);
  }
  const pagedExtraIds = pagedRawCampaigns
    .filter((c) => !pagedCampaigns.find((p) => p.id === c.id))
    .map((c) => c.id);

  const allIdsForStats = [...pagedPrimaryCampaignIds, ...pagedExtraIds];
  const rawStatsAgg = allIdsForStats.length > 0
    ? await prisma.ads_daily_stats.groupBy({
        by: ["campaign_id"],
        where: {
          campaign_id: { in: allIdsForStats },
          date: { gte: statsMonthStart, lt: statsNextMonth },
          is_deleted: 0,
        },
        _sum: { cost: true },
      })
    : [];

  const campaignToUm = new Map<string, string>();
  for (const c of pagedCampaigns) campaignToUm.set(c.id.toString(), c.user_merchant_id.toString());
  for (const c of pagedRawCampaigns) {
    if (campaignToUm.has(c.id.toString())) continue;
    const gcidKey = pagedDupToGcid.get(c.id.toString());
    const primaryId = gcidKey ? pagedGcidToPrimary.get(gcidKey) : undefined;
    if (primaryId) {
      const umKey = campaignToUm.get(primaryId);
      if (umKey) campaignToUm.set(c.id.toString(), umKey);
    }
  }

  const mergedCostByCampaign = new Map<string, number>();
  for (const s of rawStatsAgg) {
    const gcidKey = pagedDupToGcid.get(s.campaign_id.toString());
    const primaryId = gcidKey ? pagedGcidToPrimary.get(gcidKey) : s.campaign_id.toString();
    const key = primaryId || s.campaign_id.toString();
    const cost = Number(s._sum.cost || 0);
    if (!mergedCostByCampaign.has(key) || cost > mergedCostByCampaign.get(key)!) {
      mergedCostByCampaign.set(key, cost);
    }
  }

  const costByUm = new Map<string, number>();
  for (const [cid, cost] of mergedCostByCampaign) {
    const umKey = campaignToUm.get(cid);
    if (!umKey) continue;
    costByUm.set(umKey, (costByUm.get(umKey) || 0) + cost);
  }

  // ─── 组装结果 ───
  const merchants = pagedEntries.map((entry) => {
    let totalCost = 0;
    for (const umId of entry.umIds) {
      totalCost += costByUm.get(umId.toString()) || 0;
    }
    const roi = totalCost > 0 ? ((entry.net_commission - totalCost) / totalCost) * 100 : 0;
    return {
      key: `${entry.merchant_id}:${entry.platform}`,
      merchant_id: entry.merchant_id,
      platform: entry.platform,
      merchant_name: entry.merchant_name,
      merchant_url: entry.merchant_url,
      category: entry.category,
      active_advertisers: entry.active_advertisers,
      monthly_commission: entry.monthly_commission,
      roi: Math.round(roi * 10) / 10,
      total_cost: Math.round(totalCost * 100) / 100,
    };
  });

  return apiSuccess(serializeData({ merchants, total, page, pageSize }));
});
