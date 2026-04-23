/**
 * /api/user/ai-analysis
 *
 * Adrian · 数据猎手 — 实时工具调用分析（Tool Calling 模式）
 * Claude 主动拉取数据工具，交互式生成报告，流式返回前端
 */
import { NextRequest } from "next/server";
import { getUserFromRequest } from "@/lib/auth";
import prisma from "@/lib/prisma";
import { dateColumnStart, dateColumnEndExclusive } from "@/lib/date-utils";
import { normalizeAiRuleProfile, getActivePersona } from "@/lib/ai-rule-profile";

export const dynamic = "force-dynamic";
export const maxDuration = 120;

// ──────────────────────────────────────────────
// 工具定义（OpenAI function calling 格式）
// ──────────────────────────────────────────────
const TOOLS = [
  {
    type: "function",
    function: {
      name: "get_account_overview",
      description: "获取用户广告账户总览：花费、总佣金（联盟平台实际数据）、已确认、待结算、ROI、点击量、曝光量，支持自定义日期范围",
      parameters: {
        type: "object",
        properties: {
          date_from: { type: "string", description: "开始日期 YYYY-MM-DD" },
          date_to:   { type: "string", description: "结束日期 YYYY-MM-DD" },
        },
        required: ["date_from", "date_to"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "get_campaign_performance",
      description: "获取各广告系列的完整诊断数据：花费/总佣金/拒付/ROI/CTR/CPC/曝光量/运行天数/最高出价(max_cpc)，佣金来自联盟平台，可按花费或ROI排序",
      parameters: {
        type: "object",
        properties: {
          date_from: { type: "string", description: "开始日期 YYYY-MM-DD" },
          date_to:   { type: "string", description: "结束日期 YYYY-MM-DD" },
          order_by:  { type: "string", enum: ["cost", "roi", "clicks", "commission"], description: "排序字段，默认cost" },
          limit:     { type: "number", description: "返回条数，默认20，最大50" },
        },
        required: ["date_from", "date_to"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "get_affiliate_summary",
      description: "获取联盟平台佣金汇总：各平台收入、拒付率、待结算金额，含全状态分布",
      parameters: {
        type: "object",
        properties: {
          date_from:  { type: "string", description: "开始日期 YYYY-MM-DD" },
          date_to:    { type: "string", description: "结束日期 YYYY-MM-DD" },
          breakdown:  { type: "string", enum: ["platform", "merchant", "daily"], description: "分组维度，默认platform" },
        },
        required: ["date_from", "date_to"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "get_daily_trend",
      description: "获取每日广告花费/佣金/ROI趋势数据，用于发现规律和异常",
      parameters: {
        type: "object",
        properties: {
          date_from: { type: "string", description: "开始日期 YYYY-MM-DD" },
          date_to:   { type: "string", description: "结束日期 YYYY-MM-DD" },
        },
        required: ["date_from", "date_to"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "get_roi_diagnosis",
      description: "ROI健康诊断：返回每条系列的花费/佣金/拒付/ROI/CTR/CPC/运行天数/最高出价，按亏损/低效/盈利分类，用于深度诊断",
      parameters: {
        type: "object",
        properties: {
          date_from: { type: "string", description: "开始日期 YYYY-MM-DD" },
          date_to:   { type: "string", description: "结束日期 YYYY-MM-DD" },
        },
        required: ["date_from", "date_to"],
      },
    },
  },
];

// ──────────────────────────────────────────────
// 工具执行（Prisma 直查）
// ──────────────────────────────────────────────
type ToolArgs = Record<string, unknown>;

/** 获取用户所有广告系列（id + user_merchant_id），与 data-center/campaigns 保持一致 */
async function getUserCampaigns(userId: bigint): Promise<{ id: bigint; user_merchant_id: bigint | null }[]> {
  return prisma.campaigns.findMany({
    where: {
      user_id: userId,
      is_deleted: 0,
      NOT: [{ google_campaign_id: null }, { google_campaign_id: "" }],
    },
    select: { id: true, user_merchant_id: true },
  });
}

/**
 * 从 affiliate_transactions 查佣金（与数据中心口径一致）。
 * 返回按 user_merchant_id 分组的佣金 Map，以及汇总合计。
 * 日期用 CST（+08:00）午夜对齐，与 data-center/campaigns 的 txnStart/txnEnd 一致。
 */
async function getCommissionFromTxn(userId: bigint, from: string, to: string): Promise<{
  byMerchant: Map<string, { total: number; approved: number; rejected: number; pending: number; orders: number }>;
  total: number; approved: number; rejected: number; pending: number;
}> {
  const txnStart = new Date(`${from}T00:00:00+08:00`);
  const txnEnd   = new Date(`${to}T23:59:59+08:00`);

  const rows = await prisma.$queryRawUnsafe<{
    user_merchant_id: bigint;
    total_c: number; approved_c: number; rejected_c: number; pending_c: number; orders: number;
  }[]>(`
    SELECT
      user_merchant_id,
      SUM(CAST(commission_amount AS DECIMAL(12,2))) AS total_c,
      SUM(CASE WHEN status IN ('approved','confirmed','paid') THEN CAST(commission_amount AS DECIMAL(12,2)) ELSE 0 END) AS approved_c,
      SUM(CASE WHEN status IN ('rejected','declined','invalid') THEN CAST(commission_amount AS DECIMAL(12,2)) ELSE 0 END) AS rejected_c,
      SUM(CASE WHEN status IN ('pending','open') THEN CAST(commission_amount AS DECIMAL(12,2)) ELSE 0 END) AS pending_c,
      COUNT(*) AS orders
    FROM affiliate_transactions
    WHERE user_id = ? AND is_deleted = 0
      AND transaction_time >= ? AND transaction_time <= ?
    GROUP BY user_merchant_id
  `, userId, txnStart, txnEnd);

  const byMerchant = new Map<string, { total: number; approved: number; rejected: number; pending: number; orders: number }>();
  let totalAgg = 0, approvedAgg = 0, rejectedAgg = 0, pendingAgg = 0;
  for (const r of rows) {
    const key = String(r.user_merchant_id);
    byMerchant.set(key, {
      total:    Number(r.total_c    || 0),
      approved: Number(r.approved_c || 0),
      rejected: Number(r.rejected_c || 0),
      pending:  Number(r.pending_c  || 0),
      orders:   Number(r.orders     || 0),
    });
    totalAgg    += Number(r.total_c    || 0);
    approvedAgg += Number(r.approved_c || 0);
    rejectedAgg += Number(r.rejected_c || 0);
    pendingAgg  += Number(r.pending_c  || 0);
  }
  return { byMerchant, total: totalAgg, approved: approvedAgg, rejected: rejectedAgg, pending: pendingAgg };
}

async function executeTool(name: string, args: ToolArgs, userId: bigint): Promise<string> {
  const from = String(args.date_from || "");
  const to   = String(args.date_to   || "");
  const fmtMoney = (v: unknown) => `$${Number(v || 0).toFixed(2)}`;

  if (name === "get_account_overview") {
    const campaigns = await getUserCampaigns(userId);
    if (!campaigns.length) return JSON.stringify({ error: "当前账户下暂无广告系列" });

    const campaignIds = campaigns.map((c) => c.id);

    // cost/clicks/impressions/orders 来自 ads_daily_stats
    const stats = await prisma.ads_daily_stats.findMany({
      where: { campaign_id: { in: campaignIds }, date: { gte: dateColumnStart(from), lt: dateColumnEndExclusive(to) }, is_deleted: 0 },
      select: { cost: true, clicks: true, impressions: true, orders: true, campaign_id: true },
    });

    const totalCost        = stats.reduce((s, r) => s + Number(r.cost ?? 0), 0);
    const totalClicks      = stats.reduce((s, r) => s + Number(r.clicks ?? 0), 0);
    const totalImpressions = stats.reduce((s, r) => s + Number(r.impressions ?? 0), 0);
    const totalOrders      = stats.reduce((s, r) => s + Number(r.orders ?? 0), 0);
    const activeCampaigns  = new Set(stats.map((r) => String(r.campaign_id))).size;

    // 佣金来自 affiliate_transactions（与数据中心口径一致）
    const comm = await getCommissionFromTxn(userId, from, to);
    const netProfit = comm.total - comm.rejected - totalCost;
    const roi = totalCost > 0 ? ((comm.total - comm.rejected - totalCost) / totalCost * 100).toFixed(1) : "N/A";
    const ctr = totalImpressions > 0 ? (totalClicks / totalImpressions * 100).toFixed(2) : "0";
    const avgCpc = totalClicks > 0 ? totalCost / totalClicks : 0;

    if (totalCost === 0 && comm.total === 0) return JSON.stringify({ error: `${from}~${to} 无广告数据` });

    return JSON.stringify({
      period: `${from} 至 ${to}`,
      total_cost:    fmtMoney(totalCost),
      total_commission: fmtMoney(comm.total),
      confirmed:     fmtMoney(comm.approved),
      rejected:      fmtMoney(comm.rejected),
      pending:       fmtMoney(comm.pending),
      net_profit:    fmtMoney(netProfit),
      roi_percent:   roi,
      total_clicks:  totalClicks,
      total_impressions: totalImpressions,
      ctr_percent:   ctr,
      avg_cpc:       fmtMoney(avgCpc),
      total_orders:  totalOrders,
      active_campaigns: activeCampaigns,
    });
  }

  if (name === "get_campaign_performance") {
    const orderBy = String(args.order_by || "cost");
    const limit   = Math.min(Number(args.limit || 20), 50);

    const campaigns = await getUserCampaigns(userId);
    if (!campaigns.length) return JSON.stringify({ error: "当前账户下暂无广告系列" });

    const campaignIds = campaigns.map((c) => c.id);

    // cost/clicks/impressions/orders 来自 ads_daily_stats
    const stats = await prisma.ads_daily_stats.findMany({
      where: { campaign_id: { in: campaignIds }, date: { gte: dateColumnStart(from), lt: dateColumnEndExclusive(to) }, is_deleted: 0 },
      select: { campaign_id: true, cost: true, clicks: true, impressions: true, orders: true },
    });
    if (!stats.length) return JSON.stringify({ error: "无数据" });

    // 佣金来自 affiliate_transactions，按 user_merchant_id 分组
    const comm = await getCommissionFromTxn(userId, from, to);
    // campaign → user_merchant_id 映射
    const campMerchantMap = new Map(campaigns.map((c) => [String(c.id), c.user_merchant_id ? String(c.user_merchant_id) : null]));

    const grouped: Record<string, { cost: number; clicks: number; impressions: number; orders: number }> = {};
    for (const r of stats) {
      const id = String(r.campaign_id);
      if (!grouped[id]) grouped[id] = { cost: 0, clicks: 0, impressions: 0, orders: 0 };
      grouped[id].cost        += Number(r.cost ?? 0);
      grouped[id].clicks      += Number(r.clicks ?? 0);
      grouped[id].impressions += Number(r.impressions ?? 0);
      grouped[id].orders      += Number(r.orders ?? 0);
    }

    const groupedIds = Object.keys(grouped).map((id) => BigInt(id));
    const campInfos = await prisma.campaigns.findMany({
      where: { id: { in: groupedIds }, is_deleted: 0 },
      select: { id: true, campaign_name: true, status: true, daily_budget: true, max_cpc_limit: true, created_at: true },
    });
    const campInfoMap = new Map(campInfos.map((c) => [String(c.id), c]));
    const today = new Date();

    const rows = Object.entries(grouped).map(([id, g]) => {
      const info       = campInfoMap.get(id);
      const mid        = campMerchantMap.get(id);
      const commData   = mid ? (comm.byMerchant.get(mid) ?? { total: 0, approved: 0, rejected: 0, orders: 0 }) : { total: 0, approved: 0, rejected: 0, orders: 0 };
      const commission = commData.total - commData.rejected;
      const roi        = g.cost > 0 ? (commission - g.cost) / g.cost * 100 : 0;
      const rawStatus  = (info?.status || "").toLowerCase();
      const status     = rawStatus === "active" ? "投放中" : rawStatus === "paused" ? "已暂停" : rawStatus || "未知";
      const ctr        = g.impressions > 0 ? (g.clicks / g.impressions * 100).toFixed(2) + "%" : "N/A";
      const daysRunning = info?.created_at ? Math.floor((today.getTime() - new Date(info.created_at).getTime()) / 86400000) : null;
      return {
        campaign_name:     info?.campaign_name || `ID-${id}`,
        status,
        daily_budget:      info?.daily_budget != null ? fmtMoney(Number(info.daily_budget)) : null,
        max_cpc:           info?.max_cpc_limit != null ? fmtMoney(Number(info.max_cpc_limit)) : null,
        days_running:      daysRunning,
        total_cost:        fmtMoney(g.cost),
        total_commission:  fmtMoney(commData.total),
        rejected_commission: fmtMoney(commData.rejected),
        net_profit:        fmtMoney(commission - g.cost),
        roi_percent:       `${roi.toFixed(1)}%`,
        health:            roi < 0 ? "亏损" : roi < 50 ? "低效" : "盈利",
        total_clicks:      g.clicks,
        impressions:       g.impressions,
        ctr,
        total_orders:      g.orders,
        cpc:               fmtMoney(g.clicks > 0 ? g.cost / g.clicks : 0),
        _sort_cost:        g.cost,
        _sort_roi:         roi,
        _sort_clicks:      g.clicks,
        _sort_commission:  commData.total,
      };
    });

    const sortKey = `_sort_${orderBy}` as keyof (typeof rows)[0];
    rows.sort((a, b) => Number(b[sortKey] ?? 0) - Number(a[sortKey] ?? 0));
    const result = rows.slice(0, limit).map(({ _sort_cost: _a, _sort_roi: _b, _sort_clicks: _c, _sort_commission: _d, ...r }) => r);

    return JSON.stringify({ period: `${from} 至 ${to}`, total_campaigns: rows.length, campaigns: result });
  }

  if (name === "get_affiliate_summary") {
    const breakdown = String(args.breakdown || "platform");
    const txs = await prisma.affiliate_transactions.findMany({
      where: {
        user_id: userId,
        is_deleted: 0,
        transaction_time: { gte: new Date(`${from}T00:00:00+08:00`), lte: new Date(`${to}T23:59:59+08:00`) },
      },
      select: { platform: true, merchant_name: true, commission_amount: true, status: true, transaction_time: true },
    });
    if (!txs.length) return JSON.stringify({ error: "无联盟交易数据" });

    const groupFn = (tx: typeof txs[0]) =>
      breakdown === "merchant" ? String(tx.merchant_name || "unknown") :
      breakdown === "daily"    ? new Date(String(tx.transaction_time)).toLocaleDateString("sv-SE", { timeZone: "Asia/Shanghai" }) :
      String(tx.platform || "unknown");

    const grouped: Record<string, { total: number; approved: number; pending: number; rejected: number; orders: number }> = {};
    for (const tx of txs) {
      const key = groupFn(tx);
      if (!grouped[key]) grouped[key] = { total: 0, approved: 0, pending: 0, rejected: 0, orders: 0 };
      const amt = Number(tx.commission_amount || 0);
      const st  = String(tx.status || "").toLowerCase();
      grouped[key].total += amt;
      grouped[key].orders++;
      if (["rejected", "declined", "invalid"].includes(st)) grouped[key].rejected += amt;
      else if (["pending", "open"].includes(st))             grouped[key].pending  += amt;
      else if (["approved", "confirmed", "paid"].includes(st)) grouped[key].approved += amt;
    }

    const grandTotal = Object.values(grouped).reduce((s, g) => s + g.total, 0);
    const result = Object.entries(grouped)
      .sort((a, b) => b[1].total - a[1].total)
      .map(([key, g]) => ({
        group:          key,
        total:          fmtMoney(g.total),
        confirmed:      fmtMoney(g.approved),
        pending:        fmtMoney(g.pending),
        rejected:       fmtMoney(g.rejected),
        rejection_rate: g.total > 0 ? `${(g.rejected / g.total * 100).toFixed(0)}%` : "0%",
        orders:         g.orders,
      }));

    return JSON.stringify({
      period:       `${from} 至 ${to}`,
      breakdown_by: breakdown,
      grand_total:  fmtMoney(grandTotal),
      groups:       result,
    });
  }

  if (name === "get_daily_trend") {
    const campaigns = await getUserCampaigns(userId);
    if (!campaigns.length) return JSON.stringify({ error: "当前账户下暂无广告系列" });

    const campaignIds = campaigns.map((c) => c.id);

    // cost/clicks/impressions/orders 按 ads_daily_stats.date 汇总
    const stats = await prisma.ads_daily_stats.findMany({
      where: { campaign_id: { in: campaignIds }, date: { gte: dateColumnStart(from), lt: dateColumnEndExclusive(to) }, is_deleted: 0 },
      select: { date: true, cost: true, clicks: true, orders: true, campaign_id: true },
      orderBy: { date: "asc" },
    });
    if (!stats.length) return JSON.stringify({ error: "无趋势数据" });

    // 佣金按 affiliate_transactions.transaction_time（CST）每日汇总
    const txnRows = await prisma.$queryRawUnsafe<{ dt: string; total_c: number; approved_c: number }[]>(`
      SELECT
        DATE(CONVERT_TZ(transaction_time, '+00:00', '+08:00')) AS dt,
        SUM(CAST(commission_amount AS DECIMAL(12,2))) AS total_c,
        SUM(CASE WHEN status IN ('approved','confirmed','paid') THEN CAST(commission_amount AS DECIMAL(12,2)) ELSE 0 END) AS approved_c
      FROM affiliate_transactions
      WHERE user_id = ? AND is_deleted = 0
        AND transaction_time >= ? AND transaction_time <= ?
      GROUP BY dt
      ORDER BY dt
    `, userId, new Date(`${from}T00:00:00+08:00`), new Date(`${to}T23:59:59+08:00`));

    const dailyComm = new Map(txnRows.map((r) => [String(r.dt), { total: Number(r.total_c || 0), approved: Number(r.approved_c || 0) }]));

    const daily: Record<string, { cost: number; clicks: number; orders: number; campaigns: Set<string> }> = {};
    for (const r of stats) {
      const dt = String(r.date).slice(0, 10);
      if (!daily[dt]) daily[dt] = { cost: 0, clicks: 0, orders: 0, campaigns: new Set() };
      daily[dt].cost   += Number(r.cost ?? 0);
      daily[dt].clicks += Number(r.clicks ?? 0);
      daily[dt].orders += Number(r.orders ?? 0);
      daily[dt].campaigns.add(String(r.campaign_id));
    }

    // 合并所有出现的日期（cost 可能有数据但 commission 当天为 0，反之亦然）
    const allDates = new Set([...Object.keys(daily), ...dailyComm.keys()]);
    const trend = [...allDates].sort().map((dt) => {
      const d    = daily[dt] ?? { cost: 0, clicks: 0, orders: 0, campaigns: new Set() };
      const c    = dailyComm.get(dt) ?? { total: 0, approved: 0 };
      const net  = c.total - d.cost;
      return {
        date:             dt,
        cost:             fmtMoney(d.cost),
        total_commission: fmtMoney(c.total),
        confirmed:        fmtMoney(c.approved),
        net_profit:       fmtMoney(net),
        roi_percent:      d.cost > 0 ? `${(net / d.cost * 100).toFixed(1)}%` : "N/A",
        cpc:              fmtMoney(d.clicks > 0 ? d.cost / d.clicks : 0),
        clicks:           d.clicks,
        orders:           d.orders,
        active_campaigns: d.campaigns.size,
      };
    });

    return JSON.stringify({ period: `${from} 至 ${to}`, daily_trend: trend });
  }

  if (name === "get_roi_diagnosis") {
    const campaigns = await getUserCampaigns(userId);
    if (!campaigns.length) return JSON.stringify({ error: "当前账户下暂无广告系列" });

    const campaignIds = campaigns.map((c) => c.id);

    const stats = await prisma.ads_daily_stats.findMany({
      where: { campaign_id: { in: campaignIds }, date: { gte: dateColumnStart(from), lt: dateColumnEndExclusive(to) }, is_deleted: 0 },
      select: { campaign_id: true, cost: true, clicks: true, impressions: true, orders: true },
    });
    if (!stats.length) return JSON.stringify({ error: "无数据，无法诊断" });

    const comm = await getCommissionFromTxn(userId, from, to);
    const campMerchantMap = new Map(campaigns.map((c) => [String(c.id), c.user_merchant_id ? String(c.user_merchant_id) : null]));

    const grouped: Record<string, { cost: number; clicks: number; impressions: number; orders: number }> = {};
    for (const r of stats) {
      const id = String(r.campaign_id);
      if (!grouped[id]) grouped[id] = { cost: 0, clicks: 0, impressions: 0, orders: 0 };
      grouped[id].cost        += Number(r.cost ?? 0);
      grouped[id].clicks      += Number(r.clicks ?? 0);
      grouped[id].impressions += Number(r.impressions ?? 0);
      grouped[id].orders      += Number(r.orders ?? 0);
    }

    const ids = Object.keys(grouped).map((id) => BigInt(id));
    const campInfos = await prisma.campaigns.findMany({
      where: { id: { in: ids }, is_deleted: 0 },
      select: { id: true, campaign_name: true, status: true, max_cpc_limit: true, created_at: true },
    });
    const campInfoMap = new Map(campInfos.map((c) => [String(c.id), c]));
    const todayD = new Date();

    const categorized = Object.entries(grouped).map(([id, g]) => {
      const info     = campInfoMap.get(id);
      const mid      = campMerchantMap.get(id);
      const commData = mid ? (comm.byMerchant.get(mid) ?? { total: 0, approved: 0, rejected: 0, orders: 0 }) : { total: 0, approved: 0, rejected: 0, orders: 0 };
      const netComm  = commData.total - commData.rejected;
      const roi      = g.cost > 0 ? (netComm - g.cost) / g.cost * 100 : 0;
      const rawSt    = (info?.status || "").toLowerCase();
      const ctr      = g.impressions > 0 ? (g.clicks / g.impressions * 100).toFixed(2) + "%" : "N/A";
      const daysRunning = info?.created_at ? Math.floor((todayD.getTime() - new Date(info.created_at).getTime()) / 86400000) : null;
      return {
        campaign_name:       info?.campaign_name || `ID-${id}`,
        status:              rawSt === "active" ? "投放中" : rawSt === "paused" ? "已暂停" : rawSt,
        days_running:        daysRunning,
        max_cpc:             info?.max_cpc_limit != null ? fmtMoney(Number(info.max_cpc_limit)) : null,
        cost:                fmtMoney(g.cost),
        total_commission:    fmtMoney(commData.total),
        rejected_commission: fmtMoney(commData.rejected),
        net_profit:          fmtMoney(netComm - g.cost),
        roi_percent:         `${roi.toFixed(1)}%`,
        ctr,
        cpc:                 fmtMoney(g.clicks > 0 ? g.cost / g.clicks : 0),
        clicks:              g.clicks,
        impressions:         g.impressions,
        orders:              g.orders,
        category:            roi < 0 ? "亏损" : roi < 50 ? "低效" : "盈利",
        _roi:                roi,
      };
    });

    categorized.sort((a, b) => a._roi - b._roi);
    const losing     = categorized.filter((r) => r.category === "亏损");
    const breakeven  = categorized.filter((r) => r.category === "低效");
    const profitable = categorized.filter((r) => r.category === "盈利");

    return JSON.stringify({
      period:  `${from} 至 ${to}`,
      summary: {
        total_campaigns: categorized.length,
        losing:     losing.length,
        breakeven:  breakeven.length,
        profitable: profitable.length,
      },
      losing_campaigns:     losing.map(({ _roi: _, ...r }) => r),
      breakeven_campaigns:  breakeven.map(({ _roi: _, ...r }) => r),
      profitable_campaigns: profitable.map(({ _roi: _, ...r }) => r),
    });
  }

  return JSON.stringify({ error: `未知工具: ${name}` });
}

// ──────────────────────────────────────────────
// 获取场景 AI 配置（data_insight 场景）
// ──────────────────────────────────────────────
async function getInsightAiConfig() {
  const models = await prisma.ai_model_configs.findMany({
    where: { scene: "data_insight", is_deleted: 0 },
    orderBy: { priority: "asc" },
    take: 3,
  });
  if (!models.length) {
    const allModels = await prisma.ai_model_configs.findMany({
      where: { is_deleted: 0 },
      orderBy: { priority: "asc" },
      take: 3,
    });
    if (!allModels.length) throw new Error("无可用 AI 模型配置");
    models.push(...allModels);
  }
  const providerIds = [...new Set(models.map((m) => m.provider_id))];
  const providers = await prisma.ai_providers.findMany({
    where: { id: { in: providerIds }, status: "active", is_deleted: 0 },
  });
  const providerMap = new Map(providers.map((p) => [String(p.id), p]));
  for (const m of models) {
    const p = providerMap.get(String(m.provider_id));
    if (p?.api_key) {
      return { apiKey: p.api_key, baseUrl: p.api_base_url || "https://api.openai.com", modelName: m.model_name };
    }
  }
  throw new Error("无可用 AI Provider");
}

// ──────────────────────────────────────────────
// POST /api/user/ai-analysis
// Body: { date_from, date_to, question? }
// Returns: SSE stream (text/event-stream)
// ──────────────────────────────────────────────
export async function POST(req: NextRequest) {
  // 鉴权
  const userPayload = getUserFromRequest(req);
  if (!userPayload) {
    return new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401 });
  }
  const userId = BigInt(userPayload.userId);

  let body: { date_from?: string; date_to?: string; question?: string };
  try {
    body = await req.json();
  } catch {
    return new Response(JSON.stringify({ error: "Invalid JSON" }), { status: 400 });
  }

  const { date_from, date_to, question } = body;
  if (!date_from || !date_to) {
    return new Response(JSON.stringify({ error: "缺少日期参数" }), { status: 400 });
  }

  const baseContext = `分析时间范围：${date_from} 至 ${date_to}`;
  const userQuestion = question?.trim()
    ? `${baseContext}\n\n${question.trim()}`
    : `${baseContext}\n\n请对该时间段的 Google Ads 账户进行全面数据分析，包括：账户总览、各系列 ROI 诊断、联盟平台收入分析、每日趋势，最后给出 3 条可执行的优化建议。`;

  // 获取 AI 配置
  let aiConfig: { apiKey: string; baseUrl: string; modelName: string };
  try {
    aiConfig = await getInsightAiConfig();
  } catch (e) {
    return new Response(JSON.stringify({ error: String(e) }), { status: 500 });
  }

  // 当前日期（服务端取，避免 AI 误判年份）
  const todayStr = new Date().toISOString().slice(0, 10);

  // 读取用户激活人设
  const adSettings = await prisma.ad_default_settings.findFirst({
    where: { user_id: userId, is_deleted: 0 },
    select: { ai_rule_profile: true },
  });
  const profile = normalizeAiRuleProfile(adSettings?.ai_rule_profile);
  const activePersona = getActivePersona(profile);
  const personaIntro = activePersona.persona || `${activePersona.name} — ${activePersona.description}`;

  // 系统提示词（角色部分来自激活人设）
  const systemPrompt = `你是「${activePersona.name}」。${personaIntro}

直接输出报告，不要任何开场白、寒暄或"数据已获取"之类的过渡语。

【当前日期】今天是 ${todayStr}（${todayStr.slice(0, 4)} 年），这是真实的服务器时间。用户传入的日期范围均为过去或当前日期，直接使用，不得质疑或要求确认。

【数据工具】
- get_account_overview：花费、总佣金、已确认、ROI、点击、曝光（佣金来自联盟平台实际数据）
- get_campaign_performance：各系列花费/总佣金/已确认/ROI 明细（佣金按商家映射）
- get_affiliate_summary：联盟平台收入明细（按平台/商家/日期分组）
- get_daily_trend：每日花费与佣金趋势（成本来自Google Ads，佣金来自联盟平台）
- get_roi_diagnosis：系列盈亏分类诊断

【佣金口径说明 — 必须遵守】
- 所有工具的佣金数据均来自联盟平台实际交易，与数据中心显示的数值完全一致
- **以 total_commission 作为佣金的唯一计算基准**，用于 ROI、净利润等所有计算
- pending（待结算）是联盟平台的正常结算周期（7-30天），不是问题，不需要单独提示或强调
- rejected（拒付）才是真正损失，可在分析中提及；confirmed 可作参考，但不影响主要结论
- 报告中直接说「佣金」即可，不要写「待结算」「未确认」「pending」等字样

【输出格式 — 严格执行】
1. 直接以 # 标题开始，无任何开场白
2. 章节用 ## 二级标题，子节用 ### 三级标题
3. 禁止在标题前加序号（如"一、""1."）
4. 数字、金额用 **加粗**，重要结论用 > 引用块
5. 表格仅用于多系列横向对比，禁止用表格罗列单一账户的 KPI 指标（如"指标|数值"两列表）
6. 列表用 - 开头，最多两层缩进
7. 禁止使用任何 emoji 或 Unicode 装饰符号
8. 禁止用竖线和短横线拼装饰性进度条或分隔线

【分析要求 — 核心】
- 这是「数据分析」，不是「数据报告」。两者的区别：
  - 数据报告：罗列数字（花费 $X，ROI -100%，系列 N 条）→ 禁止
  - 数据分析：解释原因、识别模式、给出判断（花费 $X 零成单，说明问题在 XX，建议 YY）→ 必须做到
- 每个章节的结构：先写结论/判断（1-2句话），再用数据佐证，最后给出可执行建议
- 每条建议必须具体到操作层面（说清楚做什么操作、预期效果是什么），不允许写"可以考虑优化"之类的模糊建议
- 亏损/低效系列不要逐条列举，按共同模式分组描述，最多举2-3个代表性例子，其余不展开
- 利用以下字段做深度诊断（这些字段都在工具返回值中）：
  - days_running（运行天数）+ orders=0 → 运行超过30天零佣金 = 结构性失败，建议直接暂停
  - ctr（点击率）高但 total_commission=0 → 广告吸引力OK，问题在落地页/Tracking链路
  - max_cpc 与实际 cpc 对比 → max_cpc 过低会限制流量，发现时直接指出具体数值
  - 花费极低（<$5）但 ctr 强劲的系列 → 预算受限潜力股，建议扩量并给出百分比
  - rejected_commission 占比高的系列 → 拒付风险警示
- 用户消息第一行为"分析时间范围：YYYY-MM-DD 至 YYYY-MM-DD"，直接用于工具调用，无需确认
- 主动调用多个工具，获取完整数据再开始分析
- 数据为空时只说"该时段暂无数据，请确认同步状态"，不猜测原因`;

  const messages: Array<{ role: string; content: unknown }> = [
    { role: "system", content: systemPrompt },
    { role: "user", content: userQuestion },
  ];

  // SSE 流
  const stream = new ReadableStream({
    async start(controller) {
      const enc = new TextEncoder();
      const send = (event: string, data: string) => {
        controller.enqueue(enc.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
      };

      try {
        let round = 0;
        const MAX_ROUNDS = 14; // 工具调用最多8轮 + 续写最多6轮
        // 一旦进入正文生成阶段，就不再传工具定义（防止续写轮重新触发工具调用）
        let generationStarted = false;

        while (round < MAX_ROUNDS) {
          round++;
          send("status", `[第${round}轮] ${activePersona.name} 正在思考...`);

          const base = aiConfig.baseUrl.replace(/\/+$/, "").replace(/\/v1\/messages$/, "").replace(/\/v1$/, "");
          const url = `${base}/v1/chat/completions`;

          const requestBody: Record<string, unknown> = {
            model: aiConfig.modelName,
            messages,
            max_tokens: 8192,
            temperature: 0.3,
            stream: false,
          };

          // 工具定义只在工具调用阶段传入，一旦开始生成正文就不再传
          const hasToolResults = messages.some((m) => m.role === "tool");
          const isFirstRound = round === 1;
          if (!generationStarted && (isFirstRound || hasToolResults)) {
            requestBody.tools = TOOLS;
            requestBody.tool_choice = "auto";
          }

          const res = await fetch(url, {
            method: "POST",
            headers: { Authorization: `Bearer ${aiConfig.apiKey}`, "Content-Type": "application/json" },
            body: JSON.stringify(requestBody),
            signal: AbortSignal.timeout(90000),
          });

          if (!res.ok) {
            const text = await res.text().catch(() => "");
            throw new Error(`AI API 错误: HTTP ${res.status} - ${text.slice(0, 300)}`);
          }

          const data = await res.json() as {
            choices: Array<{
              finish_reason: string;
              message: {
                role: string;
                content: string | null;
                tool_calls?: Array<{
                  id: string;
                  function: { name: string; arguments: string };
                }>;
              };
            }>;
          };

          const choice = data.choices?.[0];
          if (!choice) throw new Error("AI 返回空响应");

          const msg = choice.message;
          messages.push({ role: msg.role, content: msg.content || null });

          // 有工具调用
          if (msg.tool_calls && msg.tool_calls.length > 0) {
            // 先补全 tool_calls 到最后一条 assistant 消息
            const lastAssistant = messages[messages.length - 1] as {
              role: string;
              content: unknown;
              tool_calls?: typeof msg.tool_calls;
            };
            lastAssistant.tool_calls = msg.tool_calls;

            for (const tc of msg.tool_calls) {
              const toolName = tc.function.name;
              send("status", `Adrian 正在调用工具：${toolName}...`);

              let toolArgs: ToolArgs = {};
              try { toolArgs = JSON.parse(tc.function.arguments); } catch { /* empty */ }

              let toolResult: string;
              try {
                toolResult = await executeTool(toolName, toolArgs, userId);
              } catch (e) {
                toolResult = JSON.stringify({ error: String(e) });
              }

              send("tool", `${toolName} 返回 ${toolResult.length} 字节数据`);

              messages.push({
                role: "tool",
                content: toolResult,
                // @ts-expect-error tool_call_id is valid
                tool_call_id: tc.id,
                name: toolName,
              });
            }
            continue; // 继续下一轮
          }

          // 没有工具调用 → 正文生成阶段
          generationStarted = true;
          const content = msg.content || "";
          if (content) {
            // 分块流式发送（模拟 streaming）
            const chunkSize = 50;
            for (let i = 0; i < content.length; i += chunkSize) {
              send("content", content.slice(i, i + chunkSize));
              await new Promise((r) => setTimeout(r, 15));
            }
          }

          // finish_reason === "length" 表示模型被 token 上限截断，续写
          // 此时 generationStarted=true，下一轮不会再传工具定义
          if (choice.finish_reason === "length" && content) {
            send("status", "内容未完，继续生成...");
            messages.push({ role: "user", content: "请继续，从上文截断处接着写，不要重复已写内容。" });
            continue;
          }

          send("done", "分析完成");
          controller.close();
          return;
        }

        send("content", "\n\n⚠️ 分析轮次超限，请重试。");
        send("done", "超限退出");
        controller.close();
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        send("error", msg);
        controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      "Connection": "keep-alive",
    },
  });
}
