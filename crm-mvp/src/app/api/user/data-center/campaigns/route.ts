import { NextRequest } from "next/server";
import { getUserFromRequest, serializeData } from "@/lib/auth";
import { apiSuccess, apiError } from "@/lib/constants";
import prisma from "@/lib/prisma";
import { cachedQuery, cacheDelete } from "@/lib/cache";
import { nowCST, parseCSTDateStart, parseCSTDateEndExclusive, isTodayCST } from "@/lib/date-utils";

/**
 * GET /api/user/data-center/campaigns
 * 广告系列列表查询（数据中心主表格数据）
 *
 * F-01 修复：总览(summary/costByMcc)基于全量 campaign 聚合，不再受表格行数限制。
 * 表格行仍保留 200 条展示限制。
 *
 * 筛选参数：
 * - mcc_account_id: MCC 账户 ID（可选，不传则查所有 MCC）
 * - date_start / date_end: 日期范围
 * - status: 广告状态 ENABLED / PAUSED / REMOVED
 * - platform: 平台代码
 * - mid: 商家 MID
 * - search: 搜索广告系列名
 */
export async function GET(req: NextRequest) {
  const user = getUserFromRequest(req);
  if (!user) return apiError("未授权", 401);

  const { searchParams } = new URL(req.url);
  const mccAccountId = searchParams.get("mcc_account_id");
  const dateStart = searchParams.get("date_start");
  const dateEnd = searchParams.get("date_end");
  const statusFilter = searchParams.get("status");
  const platformFilter = searchParams.get("platform");
  const midFilter = searchParams.get("mid");
  const searchFilter = searchParams.get("search");

  const userId = BigInt(user.userId);

  // 获取用户所有 MCC 或指定 MCC
  // 兼容场景：部分账号没有自己名下的 MCC 配置，但 campaigns 已关联到共享/历史 MCC。
  // 这种情况下不能直接返回空，必须先按用户自己的 campaign 数据继续查询。
  let mccIds: bigint[] = [];
  if (mccAccountId) {
    const mcc = await cachedQuery(
      `mcc:${user.userId}:${mccAccountId}`,
      () => prisma.google_mcc_accounts.findFirst({
        where: { id: BigInt(mccAccountId), user_id: userId, is_deleted: 0 },
      }),
      30000
    );
    if (!mcc) return apiError("MCC 账户不存在", 404);
    mccIds = [BigInt(mccAccountId)];
  } else {
    const allMcc = await cachedQuery(
      `mcc_all:${user.userId}`,
      () => prisma.google_mcc_accounts.findMany({
        where: { user_id: userId, is_deleted: 0 },
        select: { id: true },
      }),
      30000
    );
    mccIds = (allMcc || []).map((m: { id: bigint }) => m.id);
  }

  // 日期范围（默认本月，东八区）
  const cstNow = nowCST();
  const start = dateStart ? parseCSTDateStart(dateStart) : cstNow.startOf("month").toDate();
  const endExclusive = dateEnd
    ? (isTodayCST(dateEnd, cstNow) ? cstNow.toDate() : parseCSTDateEndExclusive(dateEnd))
    : cstNow.toDate();

  // 构建 campaign 筛选条件
  const campaignWhere: Record<string, unknown> = {
    user_id: userId,
    google_campaign_id: { not: null },
    is_deleted: 0,
  };
  if (mccAccountId) {
    campaignWhere.mcc_id = BigInt(mccAccountId);
  } else if (mccIds.length === 1) {
    campaignWhere.mcc_id = mccIds[0];
  } else if (mccIds.length > 1) {
    campaignWhere.mcc_id = { in: mccIds };
  }
  if (statusFilter && statusFilter !== "all") {
    campaignWhere.google_status = statusFilter;
  }
  if (searchFilter) {
    campaignWhere.campaign_name = { contains: searchFilter };
  }
  if (platformFilter) {
    campaignWhere.campaign_name = {
      ...(campaignWhere.campaign_name as Record<string, unknown> || {}),
      contains: `-${platformFilter}-`,
    };
  }
  if (midFilter) {
    campaignWhere.campaign_name = {
      ...(campaignWhere.campaign_name as Record<string, unknown> || {}),
      contains: midFilter,
    };
  }

  // ─── 全量查询所有符合条件的 campaign（用于总览聚合） ───
  const allCampaigns = await prisma.campaigns.findMany({
    where: campaignWhere as never,
    orderBy: { id: "desc" },
    select: {
      id: true,
      mcc_id: true,
      google_campaign_id: true,
      customer_id: true,
      campaign_name: true,
      google_status: true,
      daily_budget: true,
      max_cpc_limit: true,
      target_country: true,
      last_google_sync_at: true,
      user_merchant_id: true,
    },
  });

  // 按「CID + Google Campaign ID」去重（保留最新一条，即 id 最大的），避免不同广告账户同号 campaign 互相吞掉花费
  const seenCampaignKeys = new Set<string>();
  const dedupedCampaigns = allCampaigns.filter((c) => {
    const dedupKey = `${c.customer_id || ""}:${c.google_campaign_id || String(c.id)}`;
    if (seenCampaignKeys.has(dedupKey)) return false;
    seenCampaignKeys.add(dedupKey);
    return true;
  });

  // MCC 信息映射
  // 这里按当前页实际命中的 mcc_id 回查，避免“账号无本人 MCC 配置但已有 campaign 数据”时丢失 MCC 名称/币种。
  const usedMccIds = [...new Set(dedupedCampaigns.map((c) => c.mcc_id).filter((id): id is bigint => id !== null))];
  const allMccInfo = usedMccIds.length > 0
    ? await prisma.google_mcc_accounts.findMany({
        where: { id: { in: usedMccIds }, is_deleted: 0 },
        select: { id: true, mcc_id: true, mcc_name: true, currency: true },
      })
    : [];
  const mccInfoMap = new Map(allMccInfo.map((m) => [String(m.id), { mcc_id: m.mcc_id, mcc_name: m.mcc_name || m.mcc_id, currency: m.currency || "USD" }]));

  const allCampaignIds = dedupedCampaigns.map((c) => c.id);

  // ─── 全量 stats 聚合（总览用） ───
  const allStatsAgg = allCampaignIds.length > 0
    ? await prisma.ads_daily_stats.groupBy({
        by: ["campaign_id"],
        where: {
          campaign_id: { in: allCampaignIds },
          date: { gte: start, lt: endExclusive },
          is_deleted: 0,
        } as never,
        _sum: { cost: true, clicks: true, impressions: true },
      })
    : [];

  const allStatsMap = new Map(
    allStatsAgg.map((s) => [
      String(s.campaign_id),
      { cost: Number(s._sum?.cost || 0), clicks: Number(s._sum?.clicks || 0), impressions: Number(s._sum?.impressions || 0) },
    ])
  );

  // ─── 全量佣金聚合（按 merchant，与日期范围一致） ───
  const commissionAgg = await prisma.$queryRawUnsafe<
    {
      user_merchant_id: bigint;
      merchant_name: string;
      total_commission: number;
      rejected_commission: number;
      approved_commission: number;
      paid_commission: number;
      pending_commission: number;
      order_count: number;
    }[]
  >(`
    SELECT
      user_merchant_id,
      MAX(merchant_name) as merchant_name,
      SUM(CAST(commission_amount AS DECIMAL(12,2))) as total_commission,
      SUM(CASE WHEN status = 'rejected' THEN CAST(commission_amount AS DECIMAL(12,2)) ELSE 0 END) as rejected_commission,
      SUM(CASE WHEN status = 'approved' THEN CAST(commission_amount AS DECIMAL(12,2)) ELSE 0 END) as approved_commission,
      SUM(CASE WHEN status = 'paid' THEN CAST(commission_amount AS DECIMAL(12,2)) ELSE 0 END) as paid_commission,
      SUM(CASE WHEN status = 'pending' THEN CAST(commission_amount AS DECIMAL(12,2)) ELSE 0 END) as pending_commission,
      COUNT(*) as order_count
    FROM affiliate_transactions
    WHERE user_id = ? AND is_deleted = 0
      AND transaction_time >= ? AND transaction_time < ?
    GROUP BY user_merchant_id
  `, userId, start, endExclusive);

  const commissionByMerchant = new Map<string, {
    commission: number; rejected: number; approved: number;
    paid: number; pending: number; orders: number; merchantName: string;
  }>();
  let totalCommissionFromTxn = 0;
  let totalRejectedFromTxn = 0;
  let totalApprovedFromTxn = 0;
  let totalPaidFromTxn = 0;
  let totalPendingFromTxn = 0;

  for (const r of commissionAgg) {
    const key = String(r.user_merchant_id);
    commissionByMerchant.set(key, {
      commission: Number(r.total_commission || 0),
      rejected: Number(r.rejected_commission || 0),
      approved: Number(r.approved_commission || 0),
      paid: Number(r.paid_commission || 0),
      pending: Number(r.pending_commission || 0),
      orders: Number(r.order_count || 0),
      merchantName: r.merchant_name || "",
    });
    totalCommissionFromTxn += Number(r.total_commission || 0);
    totalRejectedFromTxn += Number(r.rejected_commission || 0);
    totalApprovedFromTxn += Number(r.approved_commission || 0);
    totalPaidFromTxn += Number(r.paid_commission || 0);
    totalPendingFromTxn += Number(r.pending_commission || 0);
  }

  // ─── 全量计算总览 summary 和 costByMcc ───
  let totalCost = 0, totalClicks = 0, totalImpressions = 0;
  let enabledCount = 0, pausedCount = 0;
  const mccCostAccum = new Map<string, number>();

  for (const c of dedupedCampaigns) {
    const s = allStatsMap.get(String(c.id));
    const cost = s?.cost || 0;
    totalCost += cost;
    totalClicks += (s?.clicks || 0);
    totalImpressions += (s?.impressions || 0);
    if (c.google_status === "ENABLED") enabledCount++;
    if (c.google_status === "PAUSED") pausedCount++;

    const cMccId = String(c.mcc_id);
    mccCostAccum.set(cMccId, (mccCostAccum.get(cMccId) || 0) + cost);
  }

  // ─── costByMcc（含 CNY 原始金额计算） ───
  const costByMcc: { mcc_db_id: string; mcc_id: string; mcc_name: string; currency: string; cost_usd: number; cost_original?: number }[] = [];
  const cnyCostByDay = new Map<string, { mcc_db_id: string; dailyCosts: Map<string, number> }>();

  for (const [mccDbId, costUsd] of mccCostAccum) {
    const info = mccInfoMap.get(mccDbId);
    if (!info) continue;
    if (info.currency === "CNY" && costUsd > 0) {
      cnyCostByDay.set(mccDbId, { mcc_db_id: mccDbId, dailyCosts: new Map() });
    } else {
      costByMcc.push({ mcc_db_id: mccDbId, mcc_id: info.mcc_id, mcc_name: info.mcc_name, currency: info.currency, cost_usd: Number(costUsd.toFixed(2)) });
    }
  }

  if (cnyCostByDay.size > 0) {
    const cnyCampaignIds = dedupedCampaigns.filter((c) => cnyCostByDay.has(String(c.mcc_id))).map((c) => c.id);
    if (cnyCampaignIds.length > 0) {
      const cnyDailyStats = await prisma.$queryRawUnsafe<
        { mcc_id: bigint; date: Date; cost_usd: number; rate: number | null }[]
      >(`
        SELECT c.mcc_id, s.date, SUM(s.cost) as cost_usd,
          (SELECT e.rate_to_usd FROM exchange_rate_snapshots e WHERE e.currency = 'CNY' AND e.date = s.date LIMIT 1) as rate
        FROM ads_daily_stats s
        JOIN campaigns c ON c.id = s.campaign_id
        WHERE s.campaign_id IN (${cnyCampaignIds.map(() => "?").join(",")})
          AND s.date >= ? AND s.date < ? AND s.is_deleted = 0
        GROUP BY c.mcc_id, s.date
      `, ...cnyCampaignIds.map(Number), start, endExclusive);

      for (const row of cnyDailyStats) {
        const mccDbId = String(row.mcc_id);
        const rate = Number(row.rate || 0);
        const costCny = rate > 0 ? Number(row.cost_usd || 0) / rate : 0;
        const entry = cnyCostByDay.get(mccDbId);
        if (entry) entry.dailyCosts.set(row.date.toISOString(), costCny);
      }

      for (const [mccDbId, entry] of cnyCostByDay) {
        const info = mccInfoMap.get(mccDbId)!;
        const totalCostUsd = mccCostAccum.get(mccDbId) || 0;
        let totalCostCny = 0;
        for (const cny of entry.dailyCosts.values()) totalCostCny += cny;
        costByMcc.push({
          mcc_db_id: mccDbId, mcc_id: info.mcc_id, mcc_name: info.mcc_name,
          currency: "CNY", cost_usd: Number(totalCostUsd.toFixed(2)),
          cost_original: Number(totalCostCny.toFixed(2)),
        });
      }
    }
  }

  // ─── 合并 MCC 误差费用 ───
  const queryMonth = (dateStart || cstNow.startOf("month").format("YYYY-MM-DD")).slice(0, 7);
  const adjustments = await prisma.mcc_cost_adjustments.findMany({
    where: { user_id: userId, month: queryMonth, is_deleted: 0 },
  });
  const adjustMap = new Map(adjustments.map((a) => [String(a.mcc_account_id), Number(a.amount)]));
  let totalAdjustment = 0;
  for (const mcc of costByMcc) {
    const adj = adjustMap.get(mcc.mcc_db_id) || 0;
    if (adj > 0) {
      (mcc as Record<string, unknown>).adjustment = adj;
      mcc.cost_usd = Number((mcc.cost_usd + adj).toFixed(2));
      totalAdjustment += adj;
    }
  }
  totalCost += totalAdjustment;

  const summary = {
    totalCost: Number(totalCost.toFixed(2)),
    totalCommission: Number(totalCommissionFromTxn.toFixed(2)),
    totalRejectedCommission: Number(totalRejectedFromTxn.toFixed(2)),
    totalApprovedCommission: Number(totalApprovedFromTxn.toFixed(2)),
    totalPaidCommission: Number(totalPaidFromTxn.toFixed(2)),
    totalPendingCommission: Number(totalPendingFromTxn.toFixed(2)),
    totalClicks,
    totalImpressions,
    avgCpc: totalClicks > 0 ? Number((totalCost / totalClicks).toFixed(4)) : 0,
    roi: totalCost > 0 ? Number(((totalCommissionFromTxn - totalRejectedFromTxn - totalCost) / totalCost).toFixed(2)) : 0,
    campaignCount: dedupedCampaigns.length,
    enabledCount,
    pausedCount,
  };

  // ─── 表格行：按状态排序，同状态内按广告系列名称中的序号升序，取前 200 条 ───
  const STATUS_ORDER: Record<string, number> = { ENABLED: 0, PAUSED: 1, REMOVED: 2 };
  const extractSeq = (name: string | null): number => {
    if (!name) return 999999;
    const first = name.split("-")[0] || "";
    const digits = first.replace(/^[a-zA-Z]+/, "");
    return /^\d+$/.test(digits) ? parseInt(digits, 10) : 999999;
  };
  dedupedCampaigns.sort((a, b) => {
    const pa = STATUS_ORDER[a.google_status || ""] ?? 2;
    const pb = STATUS_ORDER[b.google_status || ""] ?? 2;
    if (pa !== pb) return pa - pb;
    return extractSeq(a.campaign_name) - extractSeq(b.campaign_name);
  });

  const showRemoved = statusFilter === "REMOVED" || statusFilter === "all";
  const filteredForDisplay = showRemoved
    ? dedupedCampaigns
    : dedupedCampaigns.filter((c) => c.google_status !== "REMOVED");
  const displayCampaigns = filteredForDisplay.slice(0, 200);
  const merchantWritten = new Set<string>();

  const rows = displayCampaigns.map((c) => {
    const s = allStatsMap.get(String(c.id));
    const cost = s?.cost || 0;
    const clicks = s?.clicks || 0;
    const impressions = s?.impressions || 0;
    const avgCpc = clicks > 0 ? Number((cost / clicks).toFixed(4)) : 0;

    const merchantId = String(c.user_merchant_id);
    let commission = 0, rejectedComm = 0, approvedComm = 0, orders = 0;
    if (merchantId && merchantId !== "0" && commissionByMerchant.has(merchantId) && !merchantWritten.has(merchantId)) {
      const comm = commissionByMerchant.get(merchantId)!;
      commission = comm.commission;
      rejectedComm = comm.rejected;
      approvedComm = comm.approved;
      orders = comm.orders;
      merchantWritten.add(merchantId);
    }

    const roi = cost > 0 ? Number(((commission - rejectedComm - cost) / cost).toFixed(2)) : 0;

    const cMccId = String(c.mcc_id);
    const mccInfo = mccInfoMap.get(cMccId);
    return {
      id: c.id,
      google_campaign_id: c.google_campaign_id,
      customer_id: c.customer_id,
      campaign_name: c.campaign_name,
      status: c.google_status,
      daily_budget: Number(c.daily_budget),
      max_cpc: c.max_cpc_limit ? Number(c.max_cpc_limit) : null,
      cost: Number(cost.toFixed(2)),
      clicks,
      impressions,
      cpc: avgCpc,
      commission: Number(commission.toFixed(2)),
      rejected_commission: Number(rejectedComm.toFixed(2)),
      approved_commission: Number(approvedComm.toFixed(2)),
      orders,
      roi,
      target_country: c.target_country,
      last_synced: c.last_google_sync_at,
      mcc_currency: mccInfo?.currency || "USD",
    };
  });

  return apiSuccess(serializeData({
    rows,
    summary,
    costByMcc,
    rowMeta: {
      displayedCount: displayCampaigns.length,
      totalCount: filteredForDisplay.length,
      isLimited: filteredForDisplay.length > 200,
    },
  }));
}

function emptySummary() {
  return {
    totalCost: 0,
    totalCommission: 0,
    totalRejectedCommission: 0,
    totalApprovedCommission: 0,
    totalPaidCommission: 0,
    totalPendingCommission: 0,
    totalClicks: 0,
    totalImpressions: 0,
    avgCpc: 0,
    roi: 0,
    campaignCount: 0,
    enabledCount: 0,
    pausedCount: 0,
  };
}
