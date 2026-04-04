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
      description: "获取用户广告账户总览：花费、佣金、ROI、点击量、曝光量，支持自定义日期范围",
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
      description: "获取各广告系列的花费/佣金/ROI/CPC明细，可按花费或ROI排序",
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
      description: "ROI健康诊断：找出亏损/低效/高效系列，给出数据驱动的优化建议",
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

/** 获取用户所有广告系列 ID（与 data-center/campaigns 保持一致，通过 campaigns 表中转） */
async function getUserCampaignIds(userId: bigint): Promise<bigint[]> {
  const campaigns = await prisma.campaigns.findMany({
    where: { user_id: userId, is_deleted: 0 },
    select: { id: true },
  });
  return campaigns.map((c) => c.id);
}

async function executeTool(name: string, args: ToolArgs, userId: bigint): Promise<string> {
  const from = String(args.date_from || "");
  const to   = String(args.date_to   || "");
  const fmtMoney = (v: unknown) => `$${Number(v || 0).toFixed(2)}`;

  if (name === "get_account_overview") {
    const campaignIds = await getUserCampaignIds(userId);
    if (!campaignIds.length) return JSON.stringify({ error: "当前账户下暂无广告系列" });

    const stats = await prisma.ads_daily_stats.findMany({
      where: { campaign_id: { in: campaignIds }, date: { gte: dateColumnStart(from), lt: dateColumnEndExclusive(to) }, is_deleted: 0 },
      select: { cost: true, clicks: true, impressions: true, commission: true, orders: true, campaign_id: true },
    });
    if (!stats.length) return JSON.stringify({ error: `${from}~${to} 无广告数据` });

    const totalCost = stats.reduce((s, r) => s + Number(r.cost ?? 0), 0);
    const totalClicks = stats.reduce((s, r) => s + Number(r.clicks ?? 0), 0);
    const totalImpressions = stats.reduce((s, r) => s + Number(r.impressions ?? 0), 0);
    const totalCommission = stats.reduce((s, r) => s + Number(r.commission ?? 0), 0);
    const totalOrders = stats.reduce((s, r) => s + Number(r.orders ?? 0), 0);
    const activeCampaigns = new Set(stats.map((r) => String(r.campaign_id))).size;
    const roi = totalCost > 0 ? ((totalCommission - totalCost) / totalCost * 100).toFixed(1) : "N/A";
    const ctr = totalImpressions > 0 ? (totalClicks / totalImpressions * 100).toFixed(2) : "0";
    const avgCpc = totalClicks > 0 ? totalCost / totalClicks : 0;

    return JSON.stringify({
      period: `${from} 至 ${to}`,
      total_cost: fmtMoney(totalCost),
      total_commission: fmtMoney(totalCommission),
      net_profit: fmtMoney(totalCommission - totalCost),
      roi_percent: roi,
      total_clicks: totalClicks,
      total_impressions: totalImpressions,
      ctr_percent: ctr,
      avg_cpc: fmtMoney(avgCpc),
      total_orders: totalOrders,
      active_campaigns: activeCampaigns,
    });
  }

  if (name === "get_campaign_performance") {
    const orderBy = String(args.order_by || "cost");
    const limit = Math.min(Number(args.limit || 20), 50);

    const campaignIds = await getUserCampaignIds(userId);
    if (!campaignIds.length) return JSON.stringify({ error: "当前账户下暂无广告系列" });

    const stats = await prisma.ads_daily_stats.findMany({
      where: { campaign_id: { in: campaignIds }, date: { gte: dateColumnStart(from), lt: dateColumnEndExclusive(to) }, is_deleted: 0 },
      select: { campaign_id: true, cost: true, clicks: true, impressions: true, commission: true, orders: true, rejected_commission: true },
    });
    if (!stats.length) return JSON.stringify({ error: "无数据" });

    const grouped: Record<string, { cost: number; clicks: number; impressions: number; commission: number; orders: number; rejected: number }> = {};
    for (const r of stats) {
      const id = String(r.campaign_id);
      if (!grouped[id]) grouped[id] = { cost: 0, clicks: 0, impressions: 0, commission: 0, orders: 0, rejected: 0 };
      grouped[id].cost += Number(r.cost ?? 0);
      grouped[id].clicks += Number(r.clicks ?? 0);
      grouped[id].impressions += Number(r.impressions ?? 0);
      grouped[id].commission += Number(r.commission ?? 0);
      grouped[id].orders += Number(r.orders ?? 0);
      grouped[id].rejected += Number(r.rejected_commission ?? 0);
    }

    const campaignIds = Object.keys(grouped).map((id) => BigInt(id));
    const campaigns = await prisma.campaigns.findMany({
      where: { id: { in: campaignIds }, is_deleted: 0 },
      select: { id: true, campaign_name: true, status: true, daily_budget: true },
    });
    const campMap = new Map(campaigns.map((c) => [String(c.id), c]));

    const rows = Object.entries(grouped).map(([id, g]) => {
      const info = campMap.get(id);
      const roi = g.cost > 0 ? (g.commission - g.cost) / g.cost * 100 : 0;
      const rawStatus = (info?.status || "").toLowerCase();
      const status = rawStatus === "active" ? "投放中" : rawStatus === "paused" ? "已暂停" : rawStatus || "未知";
      return {
        campaign_name: info?.campaign_name || `ID-${id}`,
        status,
        daily_budget: info?.daily_budget != null ? fmtMoney(Number(info.daily_budget)) : null,
        total_cost: fmtMoney(g.cost),
        total_commission: fmtMoney(g.commission),
        net_profit: fmtMoney(g.commission - g.cost),
        roi_percent: `${roi.toFixed(1)}%`,
        health: roi < 0 ? "亏损" : roi < 50 ? "低效" : "盈利",
        total_clicks: g.clicks,
        total_orders: g.orders,
        cpc: fmtMoney(g.clicks > 0 ? g.cost / g.clicks : 0),
        rejected_commission: fmtMoney(g.rejected),
        _sort_cost: g.cost,
        _sort_roi: roi,
        _sort_clicks: g.clicks,
        _sort_commission: g.commission,
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
        transaction_time: { gte: new Date(`${from}T00:00:00.000Z`), lte: new Date(`${to}T23:59:59.999Z`) },
      },
      select: { platform: true, merchant_name: true, commission_amount: true, status: true, transaction_time: true },
    });
    if (!txs.length) return JSON.stringify({ error: "无联盟交易数据" });

    const groupFn = (tx: typeof txs[0]) =>
      breakdown === "merchant" ? String(tx.merchant_name || "unknown") :
      breakdown === "daily" ? String(tx.transaction_time).slice(0, 10) :
      String(tx.platform || "unknown");

    const grouped: Record<string, { total: number; approved: number; pending: number; rejected: number; orders: number }> = {};
    for (const tx of txs) {
      const key = groupFn(tx);
      if (!grouped[key]) grouped[key] = { total: 0, approved: 0, pending: 0, rejected: 0, orders: 0 };
      const amt = Number(tx.commission_amount || 0);
      const st = String(tx.status || "").toLowerCase();
      grouped[key].total += amt;
      grouped[key].orders++;
      if (["rejected", "declined", "invalid"].includes(st)) grouped[key].rejected += amt;
      else if (["pending", "open"].includes(st)) grouped[key].pending += amt;
      else if (["approved", "confirmed", "paid"].includes(st)) grouped[key].approved += amt;
    }

    const grandTotal = Object.values(grouped).reduce((s, g) => s + g.total, 0);
    const result = Object.entries(grouped)
      .sort((a, b) => b[1].total - a[1].total)
      .map(([key, g]) => ({
        group: key,
        total: fmtMoney(g.total),
        approved: fmtMoney(g.approved),
        pending: fmtMoney(g.pending),
        rejected: fmtMoney(g.rejected),
        rejection_rate: g.total > 0 ? `${(g.rejected / g.total * 100).toFixed(0)}%` : "0%",
        orders: g.orders,
      }));

    return JSON.stringify({
      period: `${from} 至 ${to}`,
      breakdown_by: breakdown,
      grand_total: fmtMoney(grandTotal),
      groups: result,
    });
  }

  if (name === "get_daily_trend") {
    const campaignIds = await getUserCampaignIds(userId);
    if (!campaignIds.length) return JSON.stringify({ error: "当前账户下暂无广告系列" });

    const stats = await prisma.ads_daily_stats.findMany({
      where: { campaign_id: { in: campaignIds }, date: { gte: dateColumnStart(from), lt: dateColumnEndExclusive(to) }, is_deleted: 0 },
      select: { date: true, cost: true, clicks: true, impressions: true, commission: true, orders: true, campaign_id: true },
      orderBy: { date: "asc" },
    });
    if (!stats.length) return JSON.stringify({ error: "无趋势数据" });

    const daily: Record<string, { cost: number; clicks: number; impressions: number; commission: number; orders: number; campaigns: Set<string> }> = {};
    for (const r of stats) {
      const dt = String(r.date).slice(0, 10);
      if (!daily[dt]) daily[dt] = { cost: 0, clicks: 0, impressions: 0, commission: 0, orders: 0, campaigns: new Set() };
      daily[dt].cost += Number(r.cost ?? 0);
      daily[dt].clicks += Number(r.clicks ?? 0);
      daily[dt].impressions += Number(r.impressions ?? 0);
      daily[dt].commission += Number(r.commission ?? 0);
      daily[dt].orders += Number(r.orders ?? 0);
      daily[dt].campaigns.add(String(r.campaign_id));
    }

    const trend = Object.entries(daily).map(([dt, g]) => ({
      date: dt,
      cost: fmtMoney(g.cost),
      commission: fmtMoney(g.commission),
      net_profit: fmtMoney(g.commission - g.cost),
      roi_percent: g.cost > 0 ? `${((g.commission - g.cost) / g.cost * 100).toFixed(1)}%` : "N/A",
      cpc: fmtMoney(g.clicks > 0 ? g.cost / g.clicks : 0),
      clicks: g.clicks,
      orders: g.orders,
      active_campaigns: g.campaigns.size,
    }));

    return JSON.stringify({ period: `${from} 至 ${to}`, daily_trend: trend });
  }

  if (name === "get_roi_diagnosis") {
    const campaignIds = await getUserCampaignIds(userId);
    if (!campaignIds.length) return JSON.stringify({ error: "当前账户下暂无广告系列" });

    const stats = await prisma.ads_daily_stats.findMany({
      where: { campaign_id: { in: campaignIds }, date: { gte: dateColumnStart(from), lt: dateColumnEndExclusive(to) }, is_deleted: 0 },
      select: { campaign_id: true, cost: true, commission: true, clicks: true, orders: true },
    });
    if (!stats.length) return JSON.stringify({ error: "无数据，无法诊断" });

    const grouped: Record<string, { cost: number; commission: number; clicks: number; orders: number }> = {};
    for (const r of stats) {
      const id = String(r.campaign_id);
      if (!grouped[id]) grouped[id] = { cost: 0, commission: 0, clicks: 0, orders: 0 };
      grouped[id].cost += Number(r.cost ?? 0);
      grouped[id].commission += Number(r.commission ?? 0);
      grouped[id].clicks += Number(r.clicks ?? 0);
      grouped[id].orders += Number(r.orders ?? 0);
    }

    const ids = Object.keys(grouped).map((id) => BigInt(id));
    const campaigns = await prisma.campaigns.findMany({
      where: { id: { in: ids }, is_deleted: 0 },
      select: { id: true, campaign_name: true, status: true },
    });
    const campMap = new Map(campaigns.map((c) => [String(c.id), c]));

    const categorized = Object.entries(grouped).map(([id, g]) => {
      const info = campMap.get(id);
      const roi = g.cost > 0 ? (g.commission - g.cost) / g.cost * 100 : 0;
      const status = ((info?.status || "")).toLowerCase();
      return {
        campaign_name: info?.campaign_name || `ID-${id}`,
        status: status === "active" ? "投放中" : status === "paused" ? "已暂停" : status,
        cost: fmtMoney(g.cost),
        commission: fmtMoney(g.commission),
        net_profit: fmtMoney(g.commission - g.cost),
        roi_percent: `${roi.toFixed(1)}%`,
        cpc: fmtMoney(g.clicks > 0 ? g.cost / g.clicks : 0),
        orders: g.orders,
        category: roi < 0 ? "亏损" : roi < 50 ? "低效" : "盈利",
        _roi: roi,
      };
    });

    categorized.sort((a, b) => a._roi - b._roi);
    const losing = categorized.filter((r) => r.category === "亏损");
    const breakeven = categorized.filter((r) => r.category === "低效");
    const profitable = categorized.filter((r) => r.category === "盈利");

    return JSON.stringify({
      period: `${from} 至 ${to}`,
      summary: {
        total_campaigns: categorized.length,
        losing: losing.length,
        breakeven: breakeven.length,
        profitable: profitable.length,
      },
      losing_campaigns: losing.map(({ _roi: _, ...r }) => r),
      breakeven_campaigns: breakeven.map(({ _roi: _, ...r }) => r),
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

  const userQuestion = question?.trim() ||
    `请对我 ${date_from} 至 ${date_to} 的 Google Ads 账户进行全面的数据分析，包括：账户总览、各系列 ROI 诊断、联盟平台收入分析、每日趋势，最后给出 3 条可执行的优化建议。`;

  // 获取 AI 配置
  let aiConfig: { apiKey: string; baseUrl: string; modelName: string };
  try {
    aiConfig = await getInsightAiConfig();
  } catch (e) {
    return new Response(JSON.stringify({ error: String(e) }), { status: 500 });
  }

  // Adrian 系统提示词
  const systemPrompt = `你是 Adrian，一位专注于 Google Ads 搜索广告的数据顾问。
职业信条：「没有坏的产品，只有投错的人群和出不动的价。」

你有以下数据工具可以调用，工具返回的是当前用户的真实数据：
- get_account_overview：获取账户总览（花费、佣金、ROI、点击、曝光）
- get_campaign_performance：获取各广告系列明细
- get_affiliate_summary：获取联盟平台收入汇总
- get_daily_trend：获取每日趋势数据
- get_roi_diagnosis：ROI 健康诊断（找出亏损/低效/高效系列）

分析原则：
1. 主动调用多个工具获取完整数据，不做假设
2. 用业务化中文描述，不用 ENABLED/PAUSED/ROI 等英文缩写，用"投放中""已暂停""投资回报率"
3. 数据驱动，每条结论必须有数字支撑
4. 给出 3 条可落地的优化建议，每条建议必须附上量化预期（如：预计 ROI 提升 15%）
5. 报告用 Markdown 格式，结构清晰，数字加粗
6. 禁止使用任何 emoji 或表情符号，保持报告的专业性
7. 如果工具返回无数据或错误，直接说明"指定日期范围内暂无数据，请确认数据已完成同步"，不要猜测原因或列举可能的故障场景`;

  const messages: Array<{ role: string; content: unknown }> = [
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
        const MAX_ROUNDS = 8;

        while (round < MAX_ROUNDS) {
          round++;
          send("status", `[第${round}轮] Adrian 正在思考...`);

          const base = aiConfig.baseUrl.replace(/\/+$/, "").replace(/\/v1\/messages$/, "").replace(/\/v1$/, "");
          const url = `${base}/v1/chat/completions`;

          const requestBody: Record<string, unknown> = {
            model: aiConfig.modelName,
            messages,
            max_tokens: 4096,
            temperature: 0.3,
            stream: false,
          };

          // 如果还在工具调用阶段，传入工具定义
          const hasToolResults = messages.some((m) => m.role === "tool");
          const isFirstRound = round === 1;
          if (isFirstRound || hasToolResults) {
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

          // 没有工具调用，输出最终内容
          const content = msg.content || "";
          if (content) {
            // 分块流式发送（模拟 streaming）
            const chunkSize = 50;
            for (let i = 0; i < content.length; i += chunkSize) {
              send("content", content.slice(i, i + chunkSize));
              await new Promise((r) => setTimeout(r, 15));
            }
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
