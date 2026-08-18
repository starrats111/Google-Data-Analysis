/**
 * 广告系列看板查询（组员数据中心 / 组长组员弹窗 共用）
 *
 * 背景（D-194）：`/api/user/data-center/campaigns` 与 `/api/user/team/member-data`
 * 原本是两份复制粘贴出来的实现，member-data 的注释写着「与 data-center/campaigns 逻辑
 * 完全一致」，但组员侧后续加的过滤与自愈没有同步过去，实测已漂移出 5 处差异：
 *   1. member-data 不按活跃 MCC 过滤 → 组长多看到 435 行挂在软删/非本人 MCC 下的系列；
 *   2. member-data 不隐藏零花费的 REMOVED 系列 → 组长多看到 232 行；
 *   3. member-data 不跑「已移除 CID / 软删 MCC 下 ENABLED」自愈 → 146 行状态两边不一致；
 *   4. member-data 无条件累加 mcc_cost_adjustments（含负数、含软删 MCC 的调整）；
 *   5. member-data 无单 MCC 视图，佣金永远走全账号口径，与组员选了 MCC 时的 D-176 口径不符。
 *
 * 现在两个 route 都只负责鉴权与序列化，数据一律由本函数产出，从结构上杜绝再次漂移。
 */

import prisma from "@/lib/prisma";
import { cachedQuery } from "@/lib/cache";
import {
  nowCST, isTodayCST, dateColumnStart, dateColumnEndExclusive, dateColumnTodayEndExclusive,
} from "@/lib/date-utils";
import { sqlAffiliateTxnValidPlatformConnection } from "@/lib/affiliate-transaction-sql";
import { sqlTxnRange, sqlTxnDay, nextDayStr } from "@/lib/report-metrics";
import { mergeMerchantCampaigns } from "@/lib/merchant-campaign-merge";
import {
  buildAttributionIndex, attributeCommissionToCampaigns, toDateKey,
  type AttributionCampaign, type AttributionSpendDay, type AttributionTxnGroup,
} from "@/lib/commission-attribution";
import { countEnabledCampaigns, healEnabledUnderSoftDeletedMcc } from "@/lib/active-running";
import { loadSuspendedCidSet, normalizeCid } from "@/lib/google-ads/cid-suspension";

/** 调用方可直接把 status 映射成 HTTP 状态码返回 */
export class CampaignBoardError extends Error {
  constructor(message: string, public readonly status: number = 400) {
    super(message);
    this.name = "CampaignBoardError";
  }
}

export interface CampaignBoardFilters {
  /** MCC 账户主键；不传表示「全部 MCC」 */
  mccAccountId?: string | null;
  dateStart?: string | null;
  dateEnd?: string | null;
  /** ENABLED / PAUSED / REMOVED / all */
  status?: string | null;
  platform?: string | null;
  mid?: string | null;
  search?: string | null;
}

export interface CampaignBoardRow {
  id: bigint;
  google_campaign_id: string | null;
  customer_id: string | null;
  campaign_name: string | null;
  status: string | null;
  daily_budget: number;
  max_cpc: number | null;
  cost: number;
  clicks: number;
  impressions: number;
  cpc: number;
  commission: number;
  rejected_commission: number;
  approved_commission: number;
  orders: number;
  roi: number;
  target_country: string | null;
  last_synced: Date | null;
  mcc_currency: string;
  is_removed: boolean;
  /** D-248：所属 CID 被 Google 中止（suspended/cancelled）——ENABLED 显示「被中止」，全部锁操作 */
  cid_suspended: boolean;
  /** D-238 IS_Bgt/IS_Rnk：区间内最新一日值（0-1 分数，前端 ×100 展示；未采集为 null） */
  is_budget: number | null;
  is_rank: number | null;
}

export interface CampaignBoardSummary {
  totalCost: number;
  totalCommission: number;
  totalRejectedCommission: number;
  totalApprovedCommission: number;
  totalPaidCommission: number;
  totalPendingCommission: number;
  totalClicks: number;
  totalImpressions: number;
  totalOrders: number;
  avgCpc: number;
  /** 毛口径倍数（(佣金-花费)/花费），前端直接按倍数展示，不换算百分比 */
  roi: number;
  campaignCount: number;
  enabledCount: number;
  pausedCount: number;
  todayAdsCount: number | null;
  scriptConfigured: boolean;
  /**
   * "filtered"=有行级筛选，仅当前可见行的归属佣金；
   * "mcc"=仅当前 MCC 归属佣金；
   * "all"=全账号全量佣金（含无广告系列商家的佣金）
   */
  commissionScope: "filtered" | "mcc" | "all";
}

export interface CampaignBoardCostByMcc {
  mcc_db_id: string;
  mcc_id: string;
  mcc_name: string;
  currency: string;
  cost_usd: number;
  cost_original?: number;
  adjustment?: number;
}

export interface CampaignBoardMccAccount {
  id: string;
  mcc_id: string;
  mcc_name: string;
  currency: string;
}

export interface CampaignBoardResult {
  rows: CampaignBoardRow[];
  summary: CampaignBoardSummary;
  costByMcc: CampaignBoardCostByMcc[];
  rowMeta: { displayedCount: number; totalCount: number; isLimited: boolean };
  /** 该用户的活跃 MCC 列表（供筛选下拉使用；组长弹窗据此切到与组员相同的 MCC） */
  mccAccounts: CampaignBoardMccAccount[];
}

/** 广告系列名前缀里的数字序号，用于同状态内排序 */
function extractSeq(name: string | null): number {
  if (!name) return 999999;
  const first = name.split("-")[0] || "";
  const digits = first.replace(/^[a-zA-Z]+/, "");
  return /^\d+$/.test(digits) ? parseInt(digits, 10) : 999999;
}

const STATUS_ORDER: Record<string, number> = { ENABLED: 0, PAUSED: 1, REMOVED: 2 };

export async function queryCampaignBoard(
  userId: bigint,
  filters: CampaignBoardFilters = {},
): Promise<CampaignBoardResult> {
  const { mccAccountId, dateStart, dateEnd, status: statusFilter, platform: platformFilter, mid: midFilter, search: searchFilter } = filters;

  // ─── MCC 范围 ───
  // 兼容场景：部分账号没有自己名下的 MCC 配置，但 campaigns 已关联到共享/历史 MCC。
  // 这种情况下不能直接返回空，必须先按用户自己的 campaign 数据继续查询。
  const activeMcc = await cachedQuery(
    `mcc_all_v2:${userId}`,
    () => prisma.google_mcc_accounts.findMany({
      where: { user_id: userId, is_deleted: 0 },
      select: { id: true, mcc_id: true, mcc_name: true, currency: true },
      orderBy: { created_at: "desc" },
    }),
    30000,
  );
  const mccAccounts: CampaignBoardMccAccount[] = (activeMcc || []).map((m) => ({
    id: String(m.id),
    mcc_id: m.mcc_id,
    mcc_name: m.mcc_name || m.mcc_id,
    currency: m.currency || "USD",
  }));

  let mccIds: bigint[];
  if (mccAccountId) {
    const hit = (activeMcc || []).find((m) => String(m.id) === String(mccAccountId));
    if (!hit) throw new CampaignBoardError("MCC 账户不存在", 404);
    mccIds = [hit.id];
  } else {
    mccIds = (activeMcc || []).map((m) => m.id);
  }

  // D-248：收集「被中止 CID」集合（只看 Google 真值 status=suspended/cancelled，
  // 管理员手动标 D 不算）。旗下 ENABLED 系列前端派生显示「被中止」并锁操作。
  // 旧 D-040 v3 的「自愈改判 PAUSED」已删除：它抹掉「中止时正在投」的信息，
  // 与 D-248「以 Google 侧真实状态为准」冲突——库里保留 Google 真值，展示层派生。
  const suspendedCidSet = await loadSuspendedCidSet(mccIds);

  // D-183：软删 MCC 下残留 ENABLED 同步自愈（与小组总览口径一致，避免换链等链路误当成在跑）
  await healEnabledUnderSoftDeletedMcc([userId]);

  // ─── 日期范围（默认本月，东八区） ───
  const cstNow = nowCST();
  const monthStartStr = cstNow.startOf("month").format("YYYY-MM-DD");
  const todayStr = cstNow.format("YYYY-MM-DD");

  // ads_daily_stats.date 是 DATE 列，必须用 UTC 午夜对齐，否则 CST→UTC 会偏移一天
  const statsDateStart = dateStart ? dateColumnStart(dateStart) : dateColumnStart(monthStartStr);
  const statsDateEnd = dateEnd
    ? (isTodayCST(dateEnd, cstNow) ? dateColumnTodayEndExclusive() : dateColumnEndExclusive(dateEnd))
    : dateColumnTodayEndExclusive();

  // 佣金切日统一走 report-metrics 的 sqlTxnRange（与佣金详情弹窗 / 收支报表 / 结算查询同源）。
  // LH 的 transaction_time 入库时就是北京时间钟面，不能再按 UTC→CST 换算，否则窗口整体前移 8 小时，
  // 会把上月最后 8 小时的 LH 单算进本月、并漏掉本月最后 8 小时的单。
  const txnStartStr = dateStart || monthStartStr;
  const txnEndExclusiveStr = nextDayStr(dateEnd || todayStr);
  const txnRange = sqlTxnRange("affiliate_transactions", txnStartStr, txnEndExclusiveStr);

  // ─── campaign 范围条件（MCC 可见性，不含行级筛选） ───
  // D-196：拆成「范围」与「行级筛选」两层。范围决定这个账号在这个 MCC 视图下总共有哪些系列，
  // 用来做佣金归属；行级筛选（状态/平台/MID/搜索）只决定表格显示哪几行。
  const campaignScopeWhere: Record<string, unknown> = {
    user_id: userId,
    NOT: [
      { google_campaign_id: null },
      { google_campaign_id: "" },
    ],
    is_deleted: 0,
  };
  if (mccAccountId) {
    campaignScopeWhere.mcc_id = mccIds[0];
  } else if (mccIds.length >= 1) {
    campaignScopeWhere.mcc_id = mccIds.length === 1 ? mccIds[0] : { in: mccIds };
  } else {
    // 无活跃 MCC：排除软删 MCC 上的系列（不把历史软删 MCC 当成「全部」展示）
    const deletedMccs = await prisma.google_mcc_accounts.findMany({
      where: { user_id: userId, is_deleted: 1 },
      select: { id: true },
    });
    if (deletedMccs.length > 0) {
      campaignScopeWhere.NOT = [
        ...(campaignScopeWhere.NOT as object[]),
        { mcc_id: { in: deletedMccs.map((m) => m.id) } },
      ];
    }
  }

  // ─── 行级筛选条件 ───
  const campaignWhere: Record<string, unknown> = { ...campaignScopeWhere };
  if (statusFilter && statusFilter !== "all") {
    campaignWhere.google_status = statusFilter;
  }
  // 三个名称条件必须叠加成 AND：写在同一个 campaign_name 对象里 contains 会互相覆盖，
  // 导致「平台 + MID」同时选时只有最后一个生效。
  const nameConditions: object[] = [];
  if (searchFilter) nameConditions.push({ campaign_name: { contains: searchFilter } });
  if (platformFilter) nameConditions.push({ campaign_name: { contains: `-${platformFilter}-` } });
  if (midFilter) nameConditions.push({ campaign_name: { contains: midFilter } });
  if (nameConditions.length > 0) campaignWhere.AND = nameConditions;

  // 行级筛选是否生效——决定总览佣金要不要跟着收窄
  const hasRowFilter = Boolean(
    (statusFilter && statusFilter !== "all") || searchFilter || platformFilter || midFilter,
  );

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
      platform_connection_id: true,
      created_at: true,
    },
  });

  // 按 google_campaign_id 去重（Google Campaign ID 全局唯一）
  // 优先保留有 customer_id 的记录；同条件下保留 id 最大的
  const gcidGroups = new Map<string, typeof allCampaigns>();
  for (const c of allCampaigns) {
    const gcid = c.google_campaign_id || String(c.id);
    if (!gcidGroups.has(gcid)) gcidGroups.set(gcid, []);
    gcidGroups.get(gcid)!.push(c);
  }
  const dedupedCampaigns: typeof allCampaigns = [];
  const extraCampaignIds: bigint[] = [];
  for (const [, group] of gcidGroups) {
    group.sort((a, b) => {
      if (a.customer_id && !b.customer_id) return -1;
      if (!a.customer_id && b.customer_id) return 1;
      return Number(b.id) - Number(a.id);
    });
    dedupedCampaigns.push(group[0]);
    for (let i = 1; i < group.length; i++) extraCampaignIds.push(group[i].id);
  }

  // MCC 信息映射
  // 按当前页实际命中的 mcc_id 回查，避免「账号无本人 MCC 配置但已有 campaign 数据」时丢失名称/币种。
  const usedMccIds = [...new Set(dedupedCampaigns.map((c) => c.mcc_id).filter((id): id is bigint => id !== null))];
  const allMccInfo = usedMccIds.length > 0
    ? await prisma.google_mcc_accounts.findMany({
        where: { id: { in: usedMccIds }, is_deleted: 0 },
        select: { id: true, mcc_id: true, mcc_name: true, currency: true },
      })
    : [];
  const mccInfoMap = new Map(allMccInfo.map((m) => [String(m.id), { mcc_id: m.mcc_id, mcc_name: m.mcc_name || m.mcc_id, currency: m.currency || "USD" }]));

  const allCampaignIds = dedupedCampaigns.map((c) => c.id);
  const allCampaignIdsIncludingDupes = [...allCampaignIds, ...extraCampaignIds];

  const campaignIdToGcid = new Map<string, string>();
  for (const c of allCampaigns) {
    campaignIdToGcid.set(String(c.id), c.google_campaign_id || String(c.id));
  }
  const gcidToPrimaryCampaignId = new Map<string, string>();
  for (const c of dedupedCampaigns) {
    gcidToPrimaryCampaignId.set(c.google_campaign_id || String(c.id), String(c.id));
  }

  // ─── 全量 stats 聚合 + 佣金聚合（并行查询） ───
  const allStatsMap = new Map<string, { cost: number; clicks: number; impressions: number }>();

  const [rawStatsRows, commissionAgg, spendCalendarRows] = await Promise.all([
    allCampaignIdsIncludingDupes.length > 0
      ? prisma.ads_daily_stats.groupBy({
          by: ["campaign_id", "date"],
          where: {
            campaign_id: { in: allCampaignIdsIncludingDupes },
            date: { gte: statsDateStart, lt: statsDateEnd },
            is_deleted: 0,
          } as never,
          _sum: { cost: true, clicks: true, impressions: true },
        })
      : [],
    // D-168：加 platform_connection_id 维度——同商家被多个联盟账号投放时，佣金按交易归属的账号精确投行
    // D-211：再加「平台后台自然日」维度——佣金要按交易发生那天在跑的系列归因，日粒度不可少
    prisma.$queryRawUnsafe<
      {
        user_merchant_id: bigint;
        platform_connection_id: bigint | null;
        txn_day: string;
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
        platform_connection_id,
        ${sqlTxnDay("affiliate_transactions")} as txn_day,
        SUM(CAST(commission_amount AS DECIMAL(12,2))) as total_commission,
        SUM(CASE WHEN status = 'rejected' THEN CAST(commission_amount AS DECIMAL(12,2)) ELSE 0 END) as rejected_commission,
        SUM(CASE WHEN status = 'approved' THEN CAST(commission_amount AS DECIMAL(12,2)) ELSE 0 END) as approved_commission,
        SUM(CASE WHEN status = 'paid' THEN CAST(commission_amount AS DECIMAL(12,2)) ELSE 0 END) as paid_commission,
        SUM(CASE WHEN status = 'pending' THEN CAST(commission_amount AS DECIMAL(12,2)) ELSE 0 END) as pending_commission,
        COUNT(*) as order_count
      FROM affiliate_transactions
      WHERE user_id = ? AND is_deleted = 0
        AND ${txnRange.cond}
        AND ${sqlAffiliateTxnValidPlatformConnection("affiliate_transactions")}
      GROUP BY user_merchant_id, platform_connection_id, txn_day
    `, userId, ...txnRange.params),
    // D-211：全历史花费日历（只取真正花过钱的日子）。归因要回溯「交易日当天或之前最近一次
    // 花钱的系列」，广告可能上月就停了、这个月才到账，所以不能只取当前查询区间。
    // 实测单用户上限约 5 千行，一次全拉即可。
    prisma.ads_daily_stats.findMany({
      where: { user_id: userId, is_deleted: 0, cost: { gt: 0 } } as never,
      select: { campaign_id: true, date: true, cost: true },
    }),
  ]);

  // D-238：IS_Bgt/IS_Rnk 取区间内最新一日非空值（与 kyads 列表口径一致，非平均）
  const latestIsMap = new Map<string, { is_budget: number; is_rank: number; date: string }>();
  if (allCampaignIdsIncludingDupes.length > 0) {
    const isRows = await prisma.ads_daily_stats.findMany({
      where: {
        campaign_id: { in: allCampaignIdsIncludingDupes },
        date: { gte: statsDateStart, lt: statsDateEnd },
        is_deleted: 0,
        is_budget: { not: null },
      } as never,
      select: { campaign_id: true, date: true, is_budget: true, is_rank: true },
      orderBy: { date: "desc" },
    });
    for (const r of isRows) {
      const gcid = campaignIdToGcid.get(String(r.campaign_id));
      const primaryId = gcid ? (gcidToPrimaryCampaignId.get(gcid) || String(r.campaign_id)) : String(r.campaign_id);
      if (!latestIsMap.has(primaryId)) {
        latestIsMap.set(primaryId, {
          is_budget: Number(r.is_budget),
          is_rank: Number(r.is_rank ?? 0),
          date: r.date.toISOString().slice(0, 10),
        });
      }
    }
  }

  if (rawStatsRows.length > 0) {
    const gcidDateBest = new Map<string, { primaryId: string; cost: number; clicks: number; impressions: number }>();
    for (const s of rawStatsRows) {
      const gcid = campaignIdToGcid.get(String(s.campaign_id));
      const primaryId = gcid ? (gcidToPrimaryCampaignId.get(gcid) || String(s.campaign_id)) : String(s.campaign_id);
      const dateKey = s.date instanceof Date ? s.date.toISOString().split("T")[0] : String(s.date);
      const dedupKey = `${primaryId}_${dateKey}`;
      const cost = Number(s._sum?.cost || 0);
      const clicks = Number(s._sum?.clicks || 0);
      const impressions = Number(s._sum?.impressions || 0);
      const prev = gcidDateBest.get(dedupKey);
      if (!prev || cost > prev.cost) {
        gcidDateBest.set(dedupKey, { primaryId, cost, clicks, impressions });
      }
    }

    for (const entry of gcidDateBest.values()) {
      const existing = allStatsMap.get(entry.primaryId);
      if (existing) {
        existing.cost += entry.cost;
        existing.clicks += entry.clicks;
        existing.impressions += entry.impressions;
      } else {
        allStatsMap.set(entry.primaryId, { cost: entry.cost, clicks: entry.clicks, impressions: entry.impressions });
      }
    }
  }

  // D-211：佣金按 (商家, 联盟账号, 交易日) 分组，交给归因引擎按花费时间轴定位到具体系列
  const commissionGroups: AttributionTxnGroup[] = [];
  let totalCommissionFromTxn = 0;
  let totalRejectedFromTxn = 0;
  let totalApprovedFromTxn = 0;
  let totalPaidFromTxn = 0;
  let totalPendingFromTxn = 0;
  let totalOrdersFromTxn = 0;

  for (const r of commissionAgg) {
    commissionGroups.push({
      merchantId: String(r.user_merchant_id),
      connId: r.platform_connection_id ? String(r.platform_connection_id) : null,
      date: String(r.txn_day),
      commission: Number(r.total_commission || 0),
      rejected: Number(r.rejected_commission || 0),
      approved: Number(r.approved_commission || 0),
      paid: Number(r.paid_commission || 0),
      pending: Number(r.pending_commission || 0),
      orders: Number(r.order_count || 0),
    });
    totalCommissionFromTxn += Number(r.total_commission || 0);
    totalRejectedFromTxn += Number(r.rejected_commission || 0);
    totalApprovedFromTxn += Number(r.approved_commission || 0);
    totalPaidFromTxn += Number(r.paid_commission || 0);
    totalPendingFromTxn += Number(r.pending_commission || 0);
    totalOrdersFromTxn += Number(r.order_count || 0);
  }

  // 代表行选举（D-168：已启用优先 → created_at 最近 → id 大）。
  // D-211 起代表行只作为归因兜底：交易日早于该商家全部花费记录时才投到这里。
  const merge = mergeMerchantCampaigns(dedupedCampaigns, allStatsMap);

  // D-176 v2：单 MCC 模式下，佣金归属必须基于【全量 campaign（跨 MCC）】全局计算一次——
  // 若只在筛选后的集合内路由，同商家在两个 MCC 各有系列时，每个 MCC 视图都会把该商家
  // 全部佣金投给本视图的代表行，导致同一笔佣金在多个 MCC 重复计入（wj02 实测复现）。
  //
  // D-196：行级筛选（状态/平台/MID/搜索）同理——若只在筛选后的集合内选举代表行，
  // 被筛掉的系列的佣金会全部改投到留下来的那条上，同一条系列的佣金会随筛选条件变化。
  // 所以只要有任何筛选生效，代表行选举都基于「未筛选的范围集合」做。
  const isSingleMccView = Boolean(mccAccountId);
  let commissionRoutingTarget = merge.commissionTarget;
  let globalPrimaryMcc: Map<string, string | null> | null = null;
  // D-211：归因候选集与 primaryId 映射，与代表行选举同源（必须是未经视图筛选的全量集合）
  let attributionCampaigns: AttributionCampaign[] = dedupedCampaigns.map((c) => ({
    id: String(c.id),
    userMerchantId: c.user_merchant_id ? String(c.user_merchant_id) : null,
    platformConnectionId: c.platform_connection_id ? String(c.platform_connection_id) : null,
  }));
  let attributionPrimaryIdOf = new Map<string, string>();
  for (const c of allCampaigns) {
    const gcid = c.google_campaign_id || String(c.id);
    attributionPrimaryIdOf.set(String(c.id), gcidToPrimaryCampaignId.get(gcid) || String(c.id));
  }
  if (isSingleMccView || hasRowFilter) {
    const globalCampaigns = await prisma.campaigns.findMany({
      where: (isSingleMccView
        ? {
            // 单 MCC 视图必须跨 MCC 全量选举，否则同商家跨 MCC 的佣金会在每个 MCC 视图重复计入
            user_id: userId,
            NOT: [{ google_campaign_id: null }, { google_campaign_id: "" }],
            is_deleted: 0,
          }
        : campaignScopeWhere) as never,
      select: {
        id: true,
        mcc_id: true,
        google_campaign_id: true,
        customer_id: true,
        google_status: true,
        user_merchant_id: true,
        platform_connection_id: true,
        created_at: true,
      },
    });
    // 与上方筛选集合相同的 gcid 去重规则，保证组内组间 primaryId 一致
    const gGroups = new Map<string, typeof globalCampaigns>();
    for (const c of globalCampaigns) {
      const gcid = c.google_campaign_id || String(c.id);
      if (!gGroups.has(gcid)) gGroups.set(gcid, []);
      gGroups.get(gcid)!.push(c);
    }
    const globalDeduped: typeof globalCampaigns = [];
    for (const [, group] of gGroups) {
      group.sort((a, b) => {
        if (a.customer_id && !b.customer_id) return -1;
        if (!a.customer_id && b.customer_id) return 1;
        return Number(b.id) - Number(a.id);
      });
      globalDeduped.push(group[0]);
    }
    // 只取 commissionTarget（代表行选举不依赖花费统计，传空 stats 即可）
    const globalMerge = mergeMerchantCampaigns(globalDeduped, new Map());
    commissionRoutingTarget = globalMerge.commissionTarget;
    globalPrimaryMcc = new Map(globalDeduped.map((c) => [String(c.id), c.mcc_id !== null ? String(c.mcc_id) : null]));

    const globalPrimaryOfGcid = new Map<string, string>();
    for (const c of globalDeduped) globalPrimaryOfGcid.set(c.google_campaign_id || String(c.id), String(c.id));
    attributionPrimaryIdOf = new Map(
      globalCampaigns.map((c) => {
        const gcid = c.google_campaign_id || String(c.id);
        return [String(c.id), globalPrimaryOfGcid.get(gcid) || String(c.id)];
      }),
    );
    attributionCampaigns = globalDeduped.map((c) => ({
      id: String(c.id),
      userMerchantId: c.user_merchant_id ? String(c.user_merchant_id) : null,
      platformConnectionId: c.platform_connection_id ? String(c.platform_connection_id) : null,
    }));
  }

  // D-211：佣金归因——按「交易日当天或之前最近一次花钱的系列」定位，回溯不到才退回代表行
  const spendCalendar: AttributionSpendDay[] = [];
  for (const s of spendCalendarRows) {
    const primaryId = attributionPrimaryIdOf.get(String(s.campaign_id));
    if (!primaryId) continue;
    spendCalendar.push({ campaignId: primaryId, date: toDateKey(s.date), cost: Number(s.cost || 0) });
  }
  const attributionIndex = buildAttributionIndex(attributionCampaigns, spendCalendar);
  const commissionByRow = attributeCommissionToCampaigns(commissionGroups, attributionIndex, commissionRoutingTarget);

  // D-176：单 MCC 模式下，总佣金口径 =「全局归属到当前 MCC 广告系列的佣金之和」；
  // 花费此时已按 MCC 过滤，两者口径一致后 ROI/净利润才有意义。
  // 不选 MCC（全部）时保持全量交易聚合，避免商家无系列/纯自然成交的佣金被漏统计。
  //
  // D-196：花费一直是「按当前筛选后的系列」求和，佣金却走全量交易聚合，两者分母不同源——
  // 一填 MID/搜索，花费缩到那几条，佣金还是全账号的，总花费 $0 配总佣金 $4464 就是这么来的。
  // 只要有行级筛选生效，佣金/拒付/订单一律只算当前可见行上的归属佣金，与花费同源。
  const visibleRowIds = new Set(dedupedCampaigns.map((c) => String(c.id)));
  const selectedMccIdStr = isSingleMccView ? String(mccIds[0]) : null;

  let mccCommission = 0, mccRejected = 0, mccApproved = 0, mccPaid = 0, mccPending = 0, mccOrders = 0;
  if (hasRowFilter || isSingleMccView) {
    for (const [rowId, rc] of commissionByRow) {
      if (hasRowFilter) {
        if (!visibleRowIds.has(rowId)) continue;
      } else if (globalPrimaryMcc?.get(rowId) !== selectedMccIdStr) {
        continue;
      }
      mccCommission += rc.commission;
      mccRejected += rc.rejected;
      mccApproved += rc.approved;
      mccPaid += rc.paid;
      mccPending += rc.pending;
      mccOrders += rc.orders;
    }
  }
  const useRowScopedCommission = hasRowFilter || isSingleMccView;

  // ─── 全量计算总览 summary 和 costByMcc ───
  let totalCost = 0, totalClicks = 0, totalImpressions = 0;
  let pausedCount = 0;
  const mccCostAccum = new Map<string, number>();

  for (const c of dedupedCampaigns) {
    const s = allStatsMap.get(String(c.id));
    const cost = s?.cost || 0;
    totalCost += cost;
    totalClicks += (s?.clicks || 0);
    totalImpressions += (s?.impressions || 0);
    if (c.google_status === "PAUSED") pausedCount++;

    const cMccId = String(c.mcc_id);
    mccCostAccum.set(cMccId, (mccCostAccum.get(cMccId) || 0) + cost);
  }

  // ─── costByMcc（含 CNY 原始金额计算） ───
  const costByMcc: CampaignBoardCostByMcc[] = [];
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
      `, ...cnyCampaignIds.map(Number), statsDateStart, statsDateEnd);

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

  // ─── 合并 MCC 误差费用 + 今日投放数缓存 + 脚本配置状态（并行） ───
  const queryMonth = (dateStart || monthStartStr).slice(0, 7);
  const [adjustments, todayAdsCache, sheetMccCount] = await Promise.all([
    prisma.mcc_cost_adjustments.findMany({
      where: { user_id: userId, month: queryMonth, is_deleted: 0 },
    }),
    // 今日投放数：cron today-merchants-sync 每 30 分钟写入的缓存
    prisma.system_configs.findFirst({
      where: { config_key: `today_merchants_${userId}`, is_deleted: 0 },
      select: { config_value: true },
    }),
    // 脚本配置判定：统一 Google Ads Script 依赖 MCC 的 sheet_url，无一配置即视为脚本未同步
    prisma.google_mcc_accounts.count({
      where: { user_id: userId, is_deleted: 0, sheet_url: { not: null }, NOT: { sheet_url: "" } },
    }),
  ]);

  // 今日投放数（今日 CST 新建且历史无同名系列，按 gcid 去重）；缓存缺失/非当日 → null
  let todayAdsCount: number | null = null;
  if (todayAdsCache?.config_value) {
    try {
      const parsed = JSON.parse(todayAdsCache.config_value) as { ads_count?: number; date?: string };
      if (parsed.date === todayStr && typeof parsed.ads_count === "number") {
        todayAdsCount = parsed.ads_count;
      }
    } catch { /* 解析失败视为无缓存 */ }
  }
  const scriptConfigured = sheetMccCount > 0;
  const adjustMap = new Map(adjustments.map((a) => [String(a.mcc_account_id), Number(a.amount)]));
  let totalAdjustment = 0;
  for (const mcc of costByMcc) {
    const adj = adjustMap.get(mcc.mcc_db_id) || 0;
    if (adj > 0) {
      mcc.adjustment = adj;
      mcc.cost_usd = Number((mcc.cost_usd + adj).toFixed(2));
      totalAdjustment += adj;
    }
  }
  totalCost += totalAdjustment;

  // D-176 / D-196：单 MCC 或有行级筛选时用归属佣金，无筛选的「全部」视图才用全量交易佣金
  const summaryCommission = useRowScopedCommission ? mccCommission : totalCommissionFromTxn;
  const summaryRejected = useRowScopedCommission ? mccRejected : totalRejectedFromTxn;
  const summaryApproved = useRowScopedCommission ? mccApproved : totalApprovedFromTxn;
  const summaryPaid = useRowScopedCommission ? mccPaid : totalPaidFromTxn;
  const summaryPending = useRowScopedCommission ? mccPending : totalPendingFromTxn;
  const summaryOrders = useRowScopedCommission ? mccOrders : totalOrdersFromTxn;

  const summary: CampaignBoardSummary = {
    totalCost: Number(totalCost.toFixed(2)),
    totalCommission: Number(summaryCommission.toFixed(2)),
    totalRejectedCommission: Number(summaryRejected.toFixed(2)),
    totalApprovedCommission: Number(summaryApproved.toFixed(2)),
    totalPaidCommission: Number(summaryPaid.toFixed(2)),
    totalPendingCommission: Number(summaryPending.toFixed(2)),
    totalClicks,
    totalImpressions,
    totalOrders: summaryOrders,
    avgCpc: totalClicks > 0 ? Number((totalCost / totalClicks).toFixed(4)) : 0,
    roi: totalCost > 0 ? Number(((summaryCommission - totalCost) / totalCost).toFixed(2)) : 0,
    campaignCount: dedupedCampaigns.length,
    // D-195：在跑广告数 = ENABLED 系列条数，与下面的 pausedCount 同量纲
    // D-248：被中止 CID 旗下的 ENABLED（展示为「被中止」）不算在跑
    enabledCount: countEnabledCampaigns(
      dedupedCampaigns.filter((c) => !(c.customer_id && suspendedCidSet.has(normalizeCid(c.customer_id)))),
    ),
    pausedCount,
    todayAdsCount,
    scriptConfigured,
    commissionScope: hasRowFilter ? "filtered" : isSingleMccView ? "mcc" : "all",
  };

  // ─── 表格行：按状态排序，同状态内按广告系列名称中的序号升序 ───
  dedupedCampaigns.sort((a, b) => {
    const pa = STATUS_ORDER[a.google_status || ""] ?? 2;
    const pb = STATUS_ORDER[b.google_status || ""] ?? 2;
    if (pa !== pb) return pa - pb;
    return extractSeq(a.campaign_name) - extractSeq(b.campaign_name);
  });

  const showRemoved = statusFilter === "REMOVED" || statusFilter === "all";
  // D-040 v3 Q-G2=b：默认也显示「本期有花费的已移除」广告（让删除/重发广告的花费可见并标红），
  // 零花费的历史 REMOVED 仍隐藏避免列表噪声；显式筛 REMOVED/all 时全显示
  const filteredForDisplay = dedupedCampaigns.filter((c) => {
    if (c.google_status !== "REMOVED") return true;
    if (showRemoved) return true;
    // 按这一条自己的花费判断；D-211：被归因到佣金的行也必须留下，
    // 否则「上月投、这月才到账」的已移除系列会被藏起来，逐行佣金之和对不上总览。
    const s = allStatsMap.get(String(c.id));
    return (s?.cost || 0) > 0 || commissionByRow.has(String(c.id));
  });

  const rows: CampaignBoardRow[] = filteredForDisplay.map((c) => {
    // 花费/点击/展示逐条真实（D-197）：以前读 merge.displayStats，同商家多条会把花费全堆到
    // 代表行、其余行显示 0。07 实证 wavespasus 的 US 行显示 $15.00、GB 行显示 $0，而真值
    // 是 US $4.77、GB $10.23。花费本来就是逐条可分的，没必要为了迁就商家级佣金而挪走。
    const s = allStatsMap.get(String(c.id));
    const cost = s?.cost || 0;
    const clicks = s?.clicks || 0;
    const impressions = s?.impressions || 0;
    const avgCpc = clicks > 0 ? Number((cost / clicks).toFixed(4)) : 0;

    // D-211：佣金按「交易日在跑的系列」归因到具体行（详见 commission-attribution.ts）
    const rowComm = commissionByRow.get(String(c.id));
    const commission = rowComm?.commission || 0;
    const rejectedComm = rowComm?.rejected || 0;
    const approvedComm = rowComm?.approved || 0;
    const orders = rowComm?.orders || 0;

    // 毛口径（07 拍板 2026-08-04）：不扣拒付佣金，与「净利润」列刻意区分
    const roi = cost > 0
      ? Number(((commission - cost) / cost).toFixed(2))
      : 0;

    const mccInfo = mccInfoMap.get(String(c.mcc_id));
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
      // D-040 v3 Q-G2=b：前端据此标红——REMOVED 状态 或 属于被中止 CID
      is_removed: c.google_status === "REMOVED",
      // D-248：被中止 CID（Google 真值）→ 旗下 ENABLED 前端显示「被中止」，全部锁操作
      cid_suspended: c.customer_id ? suspendedCidSet.has(normalizeCid(c.customer_id)) : false,
      is_budget: latestIsMap.get(String(c.id))?.is_budget ?? null,
      is_rank: latestIsMap.get(String(c.id))?.is_rank ?? null,
    };
  });

  return {
    rows,
    summary,
    costByMcc,
    rowMeta: {
      displayedCount: rows.length,
      totalCount: filteredForDisplay.length,
      // D-040 v2 BUG-3：后端不再切片，永远 false（前端分页处理大量数据）
      isLimited: false,
    },
    mccAccounts,
  };
}
