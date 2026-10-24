import { NextRequest } from "next/server";
import { serializeData } from "@/lib/auth";
import { apiSuccess, apiError } from "@/lib/constants";
import { withLeader } from "@/lib/api-handler";
import prisma from "@/lib/prisma";
import { sqlAffiliateTxnValidPlatformConnection } from "@/lib/affiliate-transaction-sql";
import { nowCST, dateColumnStart, txnStartOfMonthUTC, txnNextMonthStartUTC } from "@/lib/date-utils";

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
    // D-340：username/display_name 用于「待审核佣金」列的成员明细 Tooltip
    select: { id: true, username: true, display_name: true },
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

  // 本月时间范围（C-080：ads_daily_stats 按 CST 月初；affiliate_transactions 按 UTC 月初）
  const cstNow = nowCST();
  const monthStartStr = cstNow.startOf("month").format("YYYY-MM-DD");
  const nextMonthStr = cstNow.startOf("month").add(1, "month").format("YYYY-MM-DD");
  const statsMonthStart = dateColumnStart(monthStartStr);
  const statsNextMonth = dateColumnStart(nextMonthStr);
  const txnMonthStart = txnStartOfMonthUTC();
  const txnNextMonth = txnNextMonthStartUTC();

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

  // ─── D-340：本组「待审核佣金」（钱还压在平台，未确认／未拒付／未支付）───
  // 口径与结算查询页「待审核($)」列逐字相同：status NOT IN ('approved','rejected','paid')。
  // 生产实测 12 个平台的 status 去重后只有 approved/paid/pending/rejected 四值、无大小写
  // 变体（normalizeTxnStatus 会把未识别状态一律落 pending），所以负向筛选 === pending 桶。
  //
  // 与结算查询页的两点差异（01 明确要求）：
  //   1. **不限时间**——要的是「商家的所有待审核佣金」，结算页带时间窗所以偏小；
  //      故这里刻意不加 transaction_time 条件，也不用上面的 txnMonthStart。
  //   2. **本组全员**——按 umIds 聚合再合并，等于该商家下本组每个人结算页数字之和；
  //      含已停投的成员（01 拍板：钱不能因为人停了广告就从列里消失）。
  //      umIds 天然只含本组成员的行，无需再 join users。
  // 只算当前页（约 50 个商家），不像月度佣金那样全量——本列不参与排序，没必要全算。
  //
  // 【为什么按 platform+merchant_id 聚合，而不是按 user_merchant_id】
  // affiliate_transactions 上**没有** user_merchant_id 索引（idx_user_merchant_id 实际是
  // [user_id, merchant_id]，名字有误导）。按 user_merchant_id IN (...) 聚合会全表扫 74 万行，
  // 生产实测 1.45s；改成按 platform+merchant_id 走 idx_platform_merchant 区间扫描后
  // 只扫 2.7 万行、0.09~0.15s。user_id IN (本组成员) 保证仍是「本组」口径。
  // 另：MID 会跨平台撞号（实测 106880 同时存在于 PM 和 RW），所以聚合键**必须**带 platform，
  // 否则会把不同平台的钱加到一起。
  // D-340：额外按 user_id 分组，拿到「这笔钱是哪几个人的」明细（Tooltip 用）。
  // 多加一个 GROUP BY 列不改变索引使用方式，仍走 idx_platform_merchant 区间扫描。
  const pendingByMerchant = new Map<string, number>();
  const pendingMembersByMerchant = new Map<
    string,
    { name: string; amount: number; state: "running" | "idle" | "released" }[]
  >();
  if (pagedEntries.length > 0) {
    // 按平台归并当前页 MID 并去重，每个平台一个 OR 分组 —— 这样每组都能走索引区间扫描
    const byPlatform = new Map<string, Set<string>>();
    for (const e of pagedEntries) {
      let set = byPlatform.get(e.platform);
      if (!set) byPlatform.set(e.platform, (set = new Set<string>()));
      set.add(e.merchant_id);
    }
    const groups: string[] = [];
    const params: (string | bigint)[] = [];
    for (const [plat, mids] of byPlatform) {
      groups.push(`(platform = ? AND merchant_id IN (${[...mids].map(() => "?").join(",")}))`);
      params.push(plat, ...mids);
    }

    const pendingAgg = await prisma.$queryRawUnsafe<
      { platform: string; merchant_id: string; user_id: bigint; pending: number | string | null }[]
    >(`
      SELECT
        platform,
        merchant_id,
        user_id,
        ROUND(SUM(CASE WHEN status NOT IN ('approved','rejected','paid')
                       THEN CAST(commission_amount AS DECIMAL(14,4)) ELSE 0 END), 2) AS pending
      FROM affiliate_transactions
      WHERE is_deleted = 0
        AND user_id IN (${memberIds.map(() => "?").join(",")})
        AND (${groups.join(" OR ")})
      GROUP BY platform, merchant_id, user_id
    `, ...memberIds, ...params);

    // 成员名映射 + 该成员在该商家上的状态判定。
    // 三态区分很重要：「在投人数」只数有 ENABLED 广告的人，而待审核佣金含全部认领过的人，
    // 所以「1 人」旁边可能挂着好几个人的钱。生产实测：真退掉商家的只有 154 行/$8.6k，
    // 而「还持有但当前没在投」多达 922 行/$146.9k —— 后者才是两列对不上的主因，必须标出来。
    const nameByUid = new Map<string, string>();
    for (const m of members) {
      nameByUid.set(m.id.toString(), m.display_name || m.username);
    }
    const holderKeys = new Set<string>();
    const runningKeys = new Set<string>();
    for (const um of allUserMerchants) {
      const mKey = `${um.merchant_id}:${um.platform}`;
      const uid = um.user_id.toString();
      holderKeys.add(`${mKey}:${uid}`);
      // 与「在投人数」同源：该 um 行下有 ENABLED 广告且归属这个人
      if (activeUsersByUmGlobal.get(um.id.toString())?.has(uid)) {
        runningKeys.add(`${mKey}:${uid}`);
      }
    }

    for (const r of pendingAgg) {
      const amount = Number(r.pending || 0);
      if (amount === 0) continue;
      const key = `${r.merchant_id}:${r.platform}`;
      pendingByMerchant.set(key, (pendingByMerchant.get(key) || 0) + amount);
      const uid = r.user_id.toString();
      const list = pendingMembersByMerchant.get(key) || [];
      const held = holderKeys.has(`${key}:${uid}`);
      const running = runningKeys.has(`${key}:${uid}`);
      list.push({
        name: nameByUid.get(uid) || `#${uid}`,
        amount: Math.round(amount * 100) / 100,
        // running=在投（计入「在投人数」）；held 但非 running=持有未在投；都不是=已退商家
        state: running ? "running" : held ? "idle" : "released",
      });
      pendingMembersByMerchant.set(key, list);
    }
    // 金额降序，让 Tooltip 里大额在前
    for (const list of pendingMembersByMerchant.values()) {
      list.sort((a, b) => b.amount - a.amount);
    }
  }

  // ─── 组装结果 ───
  const merchants = pagedEntries.map((entry) => {
    let totalCost = 0;
    for (const umId of entry.umIds) {
      totalCost += costByUm.get(umId.toString()) || 0;
    }
    // D-340：该商家下本组全员的待审核佣金（SQL 已按 platform+merchant_id 聚合完，直接取）
    const pendingCommission = pendingByMerchant.get(`${entry.merchant_id}:${entry.platform}`) || 0;
    // 毛口径 ROI（07 拍板 2026-08-04）：不扣拒付佣金，倍数口径（0.52 而非 52%），与数据中心一致
    const roi = totalCost > 0 ? (entry.monthly_commission - totalCost) / totalCost : 0;
    return {
      key: `${entry.merchant_id}:${entry.platform}`,
      merchant_id: entry.merchant_id,
      platform: entry.platform,
      merchant_name: entry.merchant_name,
      merchant_url: entry.merchant_url,
      category: entry.category,
      active_advertisers: entry.active_advertisers,
      monthly_commission: entry.monthly_commission,
      // D-340：本组全员、全时间的待审核佣金 + 成员明细（Tooltip 用）
      pending_commission: Math.round(pendingCommission * 100) / 100,
      pending_members: pendingMembersByMerchant.get(`${entry.merchant_id}:${entry.platform}`) || [],
      roi: Math.round(roi * 100) / 100,
      total_cost: Math.round(totalCost * 100) / 100,
    };
  });

  return apiSuccess(serializeData({ merchants, total, page, pageSize }));
});
