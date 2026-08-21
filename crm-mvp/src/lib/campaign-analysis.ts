/**
 * D-238 广告分析引擎（kyads「广告分析」核心逻辑移植，team 维度改 user 维度）
 *
 * 组成：
 *   1. 策略提示词切片：主决策提示词是「平衡/进攻/保守」三段合并文本，按分段标记切出单段；
 *   2. 决策解析：AI 按固定格式输出「广告系列名/最终决策/目标值」三行组，解析成结构化 action；
 *   3. 快速批量分析（一键分析 / 每日 cron）：单轮调用，输入 7 天汇总表 + 逐日明细表；
 *   4. 双层详细分析（眼睛弹窗「重新分析」）：辅助层出门控标签 → 主决策层三策略各跑一轮，
 *      合并输出完整报告，actionItems 取用户所选策略；
 *   5. 结果 upsert 到 ai_recommendations，(campaign_id, scope_key) 唯一，重分析覆盖。
 *
 * 数据口径：全部取自 ads_daily_stats（cost/clicks 来自 MCC Sheet 同步；commission/orders
 * 由 daily-stats-commission 归因回写；QS/IS/MaxCpc 由 cron ads-metrics-sync API 直拉），
 * 金额均为 USD，无需汇率换算。
 *
 * AI 调用走 CRM 统一 ai-service 场景 campaign_ad_analysis（管理台可配模型与 fallback）。
 */
import prisma from "@/lib/prisma";
import { callAiWithFallback } from "@/lib/ai-service";
import { nowCST, dateColumnStart, dateColumnEndExclusive } from "@/lib/date-utils";

// ─── 类型 ───────────────────────────────────────────────────────

export type AnalysisStrategy = "balanced" | "aggressive" | "conservative";

export const ANALYSIS_STRATEGY_LABELS: Record<AnalysisStrategy, string> = {
  balanced: "平衡版",
  aggressive: "进攻版",
  conservative: "保守版",
};

const VALID_STRATEGIES = new Set<string>(["balanced", "aggressive", "conservative"]);

export function isValidAnalysisStrategy(value: unknown): value is AnalysisStrategy {
  return typeof value === "string" && VALID_STRATEGIES.has(value);
}

export type CampaignActionType =
  | "increase_budget"
  | "decrease_budget"
  | "increase_cpc"
  | "decrease_cpc"
  | "keep"
  | "pause";

export interface CampaignActionItem {
  type: CampaignActionType;
  targetValue?: number;
  percentChange?: number;
  reason?: string;
}

const ACTION_TYPES = new Set<CampaignActionType>([
  "increase_budget", "decrease_budget", "increase_cpc", "decrease_cpc", "keep", "pause",
]);

export interface CampaignDailyStat {
  /** CRM campaigns.id（字符串化） */
  campaignId: string;
  campaignName: string;
  statDate: Date;
  impressions: number;
  clicks: number;
  spend: number;
  dailyBudget: number;
  avgCpc: number;
  maxCpc: number;
  isBudget: number; // 0-1 分数
  isRank: number; // 0-1 分数
  orders: number;
  commission: number;
  qualityScore: number;
}

export interface CampaignAnalysisResultItem {
  campaignId: string;
  status: "cached" | "generated" | "failed" | "not_configured";
  summary?: string;
  detail?: string;
  suggestedAction?: string;
  actionItems?: CampaignActionItem[];
  updatedAt?: string;
  errorMessage?: string;
}

export interface AnalysisPromptConfig {
  mainPrompt: string;
  auxPrompt: string;
  targetRoi: number;
  targetCpa: number;
}

export const RECOMMENDATION_TYPE = "campaign_ad_analysis";
export const ANALYSIS_BATCH_SIZE = 15;
const AI_SCENE = "campaign_ad_analysis";
const AI_MAX_TOKENS = 6000;
const DEFAULT_DAILY_BUDGET = 1.45;

// ─── 策略提示词切片 ──────────────────────────────────────────────

const SECTION_MARKERS: Record<AnalysisStrategy, RegExp> = {
  balanced: /^={3,}\s*平衡版\s*\(balanced\)\s*={3,}$/m,
  aggressive: /^={3,}\s*进攻版\s*\(aggressive\)\s*={3,}$/m,
  conservative: /^={3,}\s*保守版\s*\(conservative\)\s*={3,}$/m,
};

const ANY_SECTION_MARKER = /^={3,}\s*(?:平衡版|进攻版|保守版)\s*\((?:balanced|aggressive|conservative)\)\s*={3,}$/m;

export function extractStrategyPrompt(mergedPrompt: string, strategy: AnalysisStrategy): string | null {
  const markerMatch = mergedPrompt.match(SECTION_MARKERS[strategy]);
  if (!markerMatch || markerMatch.index === undefined) return null;
  const remaining = mergedPrompt.slice(markerMatch.index + markerMatch[0].length);
  const nextMarkerMatch = remaining.match(ANY_SECTION_MARKER);
  const content = nextMarkerMatch?.index !== undefined
    ? remaining.slice(0, nextMarkerMatch.index)
    : remaining;
  return content.trim();
}

// ─── 决策解析 ────────────────────────────────────────────────────

export interface BrandSearchDecision {
  campaignName: string;
  decision: string;
  targetValue: string;
}

export function parseBrandSearchResponse(text: string): BrandSearchDecision[] {
  const decisions: BrandSearchDecision[] = [];
  const lines = text.split("\n").map((l) => l.trim()).filter(Boolean);
  let current: Partial<BrandSearchDecision> = {};

  for (const line of lines) {
    const campaignMatch = line.match(/^广告系列名[：:]\s*(.+)/);
    const decisionMatch = line.match(/^最终决策[：:]\s*(.+)/);
    const targetMatch = line.match(/^目标值[：:]\s*(.+)/);

    if (campaignMatch) {
      if (current.campaignName && current.decision) {
        current.targetValue = current.targetValue || "N/A";
        decisions.push(current as BrandSearchDecision);
      }
      current = { campaignName: campaignMatch[1].trim() };
    } else if (decisionMatch) {
      current.decision = decisionMatch[1].trim();
    } else if (targetMatch) {
      current.targetValue = targetMatch[1].trim();
      if (current.campaignName && current.decision) {
        decisions.push(current as BrandSearchDecision);
        current = {};
      }
    }
  }

  if (current.campaignName && current.decision) {
    current.targetValue = current.targetValue || "N/A";
    decisions.push(current as BrandSearchDecision);
  }

  return decisions;
}

export function mapDecisionToActionType(decision: string): CampaignActionType {
  if (/加预算/.test(decision)) return "increase_budget";
  if (/减预算/.test(decision)) return "decrease_budget";
  if (/加\s*CPC/i.test(decision)) return "increase_cpc";
  if (/减\s*CPC/i.test(decision)) return "decrease_cpc";
  if (/暂停/.test(decision)) return "pause";
  return "keep";
}

export function parseTargetValue(raw: string): number | null {
  if (!raw || raw === "N/A" || raw === "n/a") return null;
  const cleaned = raw.replace(/[$￥,\s]/g, "");
  const parsed = parseFloat(cleaned);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

function toPositiveNumber(value: unknown): number | null {
  if (typeof value === "number") return Number.isFinite(value) && value > 0 ? value : null;
  if (typeof value === "string") {
    const parsed = Number(value.trim());
    return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
  }
  return null;
}

export function normalizeCampaignActionItems(raw: unknown): CampaignActionItem[] {
  if (!Array.isArray(raw)) return [];
  const result: CampaignActionItem[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const candidate = item as Record<string, unknown>;
    const type = candidate.type;
    if (typeof type !== "string" || !ACTION_TYPES.has(type as CampaignActionType)) continue;
    const reason = typeof candidate.reason === "string" && candidate.reason.trim()
      ? candidate.reason.trim() : undefined;

    if (type === "keep" || type === "pause") {
      result.push(reason ? { type: type as CampaignActionType, reason } : { type: type as CampaignActionType });
    } else {
      const targetValue = toPositiveNumber(candidate.targetValue);
      const percentChange = toPositiveNumber(candidate.percentChange);
      if (targetValue == null && percentChange == null) continue;
      const entry: CampaignActionItem = { type: type as CampaignActionType };
      if (targetValue != null) entry.targetValue = targetValue;
      if (percentChange != null) entry.percentChange = percentChange;
      if (reason) entry.reason = reason;
      result.push(entry);
    }
    if (result.length >= 2) break;
  }
  return result;
}

export function formatCampaignActionItems(items: CampaignActionItem[]): string[] {
  return items.slice(0, 2).map((item) => {
    const pct = item.percentChange;
    switch (item.type) {
      case "increase_budget":
        return pct != null ? `加预算 +${pct}%` : `加预算到 $${(item.targetValue || 0).toFixed(2)}`;
      case "decrease_budget":
        return pct != null ? `减预算 -${pct}%` : `减预算到 $${(item.targetValue || 0).toFixed(2)}`;
      case "increase_cpc":
        return pct != null ? `加CPC +${pct}%` : `加 CPC 到 $${(item.targetValue || 0).toFixed(2)}`;
      case "decrease_cpc":
        return pct != null ? `减CPC -${pct}%` : `减 CPC 到 $${(item.targetValue || 0).toFixed(2)}`;
      case "keep":
        return "维持现状";
      case "pause":
        return "暂停广告";
    }
  });
}

function normalizeCampaignNameForMatch(text: string): string {
  return text
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    .replace(/[*_`~]/g, "")
    .replace(/^(?:当前|本|该)?广告系列[:：]?\s*/i, "")
    .replace(/^[\d]+[.)、:：-]\s*/, "")
    .toLowerCase()
    .replace(/[^a-z0-9\u4e00-\u9fff]+/g, "");
}

// ─── 数据聚合与表格构建 ──────────────────────────────────────────

function fmtDollar(v: number): string { return `$${v.toFixed(2)}`; }
function fmtPct(v: number): string { return `${(v * 100).toFixed(1)}%`; }
function safeDivide(a: number, b: number): number | null { return b > 0 ? a / b : null; }
function fmtDateUtc(d: Date): string { return d.toISOString().slice(0, 10); }

export interface SummaryRowData {
  campaignId: string;
  name: string;
  dailyBudget: number;
  spend: number;
  impressions: number;
  clicks: number;
  orders: number;
  commission: number;
  avgCpc: number | null;
  maxCpc: number;
  epc: number | null;
  ctr: number | null;
  cpa: number | null;
  roi: number | null;
  isBudget: number;
  isRank: number;
  avgQualityScore: number | null;
}

function resolveEffectiveDailyBudget(stats: CampaignDailyStat[]): number {
  for (let i = stats.length - 1; i >= 0; i -= 1) {
    const budget = stats[i].dailyBudget;
    if (Number.isFinite(budget) && budget > 0) return budget;
  }
  return DEFAULT_DAILY_BUDGET;
}

export function aggregateSummaryRows(dailyStats: CampaignDailyStat[]): SummaryRowData[] {
  const grouped = new Map<string, CampaignDailyStat[]>();
  for (const stat of dailyStats) {
    const arr = grouped.get(stat.campaignId) || [];
    arr.push(stat);
    grouped.set(stat.campaignId, arr);
  }

  const result: SummaryRowData[] = [];
  for (const [campaignId, stats] of grouped) {
    const totSpend = stats.reduce((s, d) => s + d.spend, 0);
    const totImpressions = stats.reduce((s, d) => s + d.impressions, 0);
    const totClicks = stats.reduce((s, d) => s + d.clicks, 0);
    const totOrders = stats.reduce((s, d) => s + d.orders, 0);
    const totCommission = stats.reduce((s, d) => s + d.commission, 0);
    const validQs = stats.filter((d) => d.qualityScore > 0);
    // MaxCpc 取最近一天的快照（当天没有则回溯）
    let latestMaxCpc = 0;
    for (let i = stats.length - 1; i >= 0; i -= 1) {
      if (stats[i].maxCpc > 0) { latestMaxCpc = stats[i].maxCpc; break; }
    }

    result.push({
      campaignId,
      name: stats[0].campaignName,
      dailyBudget: resolveEffectiveDailyBudget(stats),
      spend: totSpend,
      impressions: totImpressions,
      clicks: totClicks,
      orders: totOrders,
      commission: totCommission,
      avgCpc: safeDivide(totSpend, totClicks),
      maxCpc: latestMaxCpc,
      epc: safeDivide(totCommission, totClicks),
      ctr: safeDivide(totClicks, totImpressions),
      cpa: safeDivide(totSpend, totOrders),
      roi: totSpend > 0 ? ((totCommission - totSpend) / totSpend) * 100 : null,
      isBudget: stats.reduce((s, d) => s + d.isBudget, 0) / stats.length,
      isRank: stats.reduce((s, d) => s + d.isRank, 0) / stats.length,
      avgQualityScore: validQs.length > 0
        ? validQs.reduce((s, d) => s + d.qualityScore, 0) / validQs.length : null,
    });
  }
  return result;
}

export function buildSummaryTable(dailyStats: CampaignDailyStat[]): string {
  const rows = aggregateSummaryRows(dailyStats);
  const header = `| 广告系列 | 日预算 | 花费 | 展示次数 | 点击 | CTR | Avg CPC | Max CPC | EPC | 转化 | 佣金 | CPA | ROI | IS_Bgt | IS_Rnk | 平均QS |`;
  const sep = `|---------|-------|------|---------|------|-----|---------|---------|-----|------|------|-----|-----|--------|--------|--------|`;
  const lines = rows.map((r) =>
    `| ${r.name} | ${fmtDollar(r.dailyBudget)} | ${fmtDollar(r.spend)} | ${r.impressions} | ${r.clicks} | ${r.ctr != null ? fmtPct(r.ctr) : "—"} | ${r.avgCpc != null ? fmtDollar(r.avgCpc) : "—"} | ${fmtDollar(r.maxCpc)} | ${r.epc != null ? fmtDollar(r.epc) : "—"} | ${r.orders} | ${fmtDollar(r.commission)} | ${r.cpa != null ? fmtDollar(r.cpa) : "—"} | ${r.roi != null ? `${r.roi.toFixed(0)}%` : "—"} | ${fmtPct(r.isBudget)} | ${fmtPct(r.isRank)} | ${r.avgQualityScore != null ? r.avgQualityScore.toFixed(1) : "—"} |`,
  );
  return [header, sep, ...lines].join("\n");
}

export function buildDailyTable(dailyStats: CampaignDailyStat[]): string {
  const header = `| 广告系列 | 日期 | 花费 | 点击 | CPC | 转化 | 佣金 | CPA | ROI | IS_Bgt | IS_Rnk | QS |`;
  const sep = `|---------|------|------|------|-----|------|------|-----|-----|--------|--------|----|`;
  const lines = dailyStats.map((d) => {
    const cpc = safeDivide(d.spend, d.clicks);
    const cpa = safeDivide(d.spend, d.orders);
    const roi = d.spend > 0 ? ((d.commission - d.spend) / d.spend) * 100 : null;
    return `| ${d.campaignName} | ${fmtDateUtc(d.statDate)} | ${fmtDollar(d.spend)} | ${d.clicks} | ${cpc != null ? fmtDollar(cpc) : "—"} | ${d.orders} | ${fmtDollar(d.commission)} | ${cpa != null ? fmtDollar(cpa) : "—"} | ${roi != null ? `${roi.toFixed(0)}%` : "—"} | ${fmtPct(d.isBudget)} | ${fmtPct(d.isRank)} | ${d.qualityScore > 0 ? d.qualityScore.toFixed(1) : "-"} |`;
  });
  return [header, sep, ...lines].join("\n");
}

/** 系统预计算洞察（IS 机会 / EPC-CPC 套利 / 浪费开支），随批量分析注入 */
export function buildAnalyticsInsights(dailyStats: CampaignDailyStat[]): string {
  const summaryRows = aggregateSummaryRows(dailyStats);
  if (summaryRows.length === 0) return "";

  const sections: string[] = [];
  const totalSpend = summaryRows.reduce((s, r) => s + r.spend, 0);

  const isRows: string[] = [];
  for (const r of summaryRows) {
    if (r.clicks === 0) continue;
    if (!(r.isBudget > 0.2 || r.isRank > 0.5)) continue;
    const rawTotalLost = r.isBudget + r.isRank;
    const bottleneck = r.isBudget > r.isRank ? "预算" : "排名";
    const bottleneckPct = bottleneck === "预算" ? fmtPct(r.isBudget) : fmtPct(r.isRank);
    const effectiveLost = rawTotalLost >= 0.9
      ? Math.max(Math.min(r.isBudget, 0.95), Math.min(r.isRank, 0.95))
      : Math.min(rawTotalLost, 0.89);
    const currentShare = Math.max(0.05, 1 - effectiveLost);
    const missedImpressions = r.impressions * (effectiveLost / currentShare);
    const ctr = r.ctr || 0;
    const cvr = r.clicks > 0 ? r.orders / r.clicks : 0;
    const avgCommission = r.orders > 0 ? r.commission / r.orders : 0;
    const missedCommission = missedImpressions * ctr * cvr * avgCommission;
    const lossLabel = rawTotalLost >= 0.9 ? `主瓶颈 ${fmtPct(effectiveLost)}` : fmtPct(effectiveLost);
    isRows.push(`| ${r.name} | ${bottleneck}(${bottleneckPct}) | ${lossLabel} | ${fmtDollar(missedCommission)}/周 |`);
  }
  if (isRows.length > 0) {
    sections.push([
      `**展示份额机会（IS丢失显著的系列）：**`,
      `| 广告系列 | 主要瓶颈 | IS总丢失 | 估算每周错失佣金 |`,
      `|---------|---------|---------|----------------|`,
      ...isRows,
      `（注意：展示份额补足后边际ROI会递减；当 IS_Bgt+IS_Rnk ≥ 90% 时，按主瓶颈占比估算，不做保守拦截）`,
    ].join("\n"));
  }

  const arbRows: string[] = [];
  for (const r of summaryRows) {
    if (r.clicks === 0 || r.avgCpc == null || r.epc == null) continue;
    const ratio = r.avgCpc > 0 ? r.epc / r.avgCpc : 0;
    const category = ratio >= 3.0 ? "🟢 高套利" : ratio >= 1.5 ? "🟡 中套利" : ratio >= 1.0 ? "🟠 微利" : "🔴 亏损";
    arbRows.push(`| ${r.name} | ${fmtDollar(r.avgCpc)} | ${fmtDollar(r.epc)} | ${ratio.toFixed(2)}x | ${category} |`);
  }
  if (arbRows.length > 0) {
    sections.push([
      `**EPC/CPC 套利空间：**`,
      `| 广告系列 | Avg CPC | EPC | 套利倍数 | 分类 |`,
      `|---------|---------|-----|---------|------|`,
      ...arbRows,
    ].join("\n"));
  }

  let silentCount = 0, silentSpend = 0, bleedCount = 0, bleedSpend = 0, lowEffCount = 0, lowEffSpend = 0;
  for (const r of summaryRows) {
    if (r.clicks === 0 || r.impressions <= 5) { silentCount++; silentSpend += r.spend; }
    else if (r.roi != null && r.roi < -50) { bleedCount++; bleedSpend += r.spend; }
    else if (r.roi != null && r.roi < 0) { lowEffCount++; lowEffSpend += r.spend; }
  }
  const wastedPct = totalSpend > 0 ? ((silentSpend + bleedSpend) / totalSpend) * 100 : 0;
  const lowEffPct = totalSpend > 0 ? (lowEffSpend / totalSpend) * 100 : 0;
  sections.push([
    `**浪费开支全景：**`,
    `- 沉默系列（0点击/≤5展示）：${silentCount} 个，花费 ${fmtDollar(silentSpend)}`,
    `- 失血系列（ROI<-50%）：${bleedCount} 个，花费 ${fmtDollar(bleedSpend)}`,
    `- 低效系列（ROI -50%~0%）：${lowEffCount} 个，花费 ${fmtDollar(lowEffSpend)}`,
    `- **浪费占比：${wastedPct.toFixed(1)}%，低效占比：${lowEffPct.toFixed(1)}%** ${wastedPct > 15 ? "⚠️ 账户健康警告" : ""}`,
    `- 账户总花费：${fmtDollar(totalSpend)}`,
  ].join("\n"));

  return sections.join("\n\n");
}

function buildBatchUserPrompt(input: {
  targetRoi: number;
  targetCpa: number;
  periodLabel: string;
  summaryTable: string;
  dailyTable: string;
  analyticsInsights?: string;
}): string {
  const roiText = input.targetRoi > 0 ? `${input.targetRoi}%` : "未设置";
  const cpaText = input.targetCpa > 0 ? `$${input.targetCpa}` : "未设置";
  const parts = [
    `## 二、目标值`,
    `- 目标 ROI：**${roiText}**`,
    `- 目标 CPA（如有）：**${cpaText}**`,
    ``,
    `## 三、输入数据`,
    `### 3.1 各广告系列 ${input.periodLabel}汇总数据`,
    input.summaryTable,
    ``,
    `### 3.2 各广告系列逐日明细（最近 ${input.periodLabel}）`,
    input.dailyTable,
    ``,
  ];
  if (input.analyticsInsights) {
    parts.push(`### 3.3 系统预计算洞察`, input.analyticsInsights, ``);
  }
  parts.push(`---`, ``, `现在请根据上面的数据和规则，直接输出分析结果。`);
  return parts.join("\n");
}

// ─── 双层详细分析（辅助层 + 主决策三策略） ────────────────────────

function buildSummaryBlock(row: SummaryRowData): string {
  return [
    `广告系列名：${row.name}`,
    ``,
    `【当前 7 天汇总数据】`,
    `- 点击：${row.clicks}`,
    `- 佣金：${fmtDollar(row.commission)}`,
    `- 花费：${fmtDollar(row.spend)}`,
    `- AVG CPC：${row.avgCpc != null ? fmtDollar(row.avgCpc) : "—"}`,
    `- MAX CPC：${fmtDollar(row.maxCpc)}`,
    `- 订单：${row.orders}`,
    `- 日预算：${fmtDollar(row.dailyBudget)}`,
    `- IS Budget丢失：${fmtPct(row.isBudget)}`,
    `- IS Rank丢失：${fmtPct(row.isRank)}`,
    `- 平均QS：${row.avgQualityScore != null ? row.avgQualityScore.toFixed(1) : "—"}`,
  ].join("\n");
}

function buildDetailedDailyTable(dailyStats: CampaignDailyStat[]): string {
  const header = `| 广告系列 | 日期 | 点击 | 花费 | 订单 | 佣金 | Avg CPC | IS_Bgt | IS_Rnk | MaxCpc | QS |`;
  const sep = `|---------|------|------|------|------|------|---------|--------|--------|--------|----|`;
  const rows = dailyStats.map((d) =>
    `| ${d.campaignName} | ${fmtDateUtc(d.statDate)} | ${d.clicks} | ${fmtDollar(d.spend)} | ${d.orders} | ${fmtDollar(d.commission)} | ${fmtDollar(d.avgCpc)} | ${fmtPct(d.isBudget)} | ${fmtPct(d.isRank)} | ${fmtDollar(d.maxCpc)} | ${d.qualityScore > 0 ? d.qualityScore.toFixed(1) : "-"} |`,
  );
  return [header, sep, ...rows].join("\n");
}

function buildQualityScoreBlock(dailyStats: CampaignDailyStat[]): string {
  const grouped = new Map<string, { date: string; qs: number }[]>();
  for (const d of dailyStats) {
    const arr = grouped.get(d.campaignName) || [];
    arr.push({ date: fmtDateUtc(d.statDate), qs: d.qualityScore });
    grouped.set(d.campaignName, arr);
  }
  const rows: string[] = [];
  for (const [name, dates] of grouped) {
    const valid = dates.filter((d) => d.qs > 0);
    if (valid.length === 0) continue;
    const avg = valid.reduce((s, d) => s + d.qs, 0) / valid.length;
    const latest = valid[valid.length - 1];
    rows.push(`- ${name}：最新QS=${latest.qs.toFixed(1)}，${valid.length}天均值=${avg.toFixed(1)}`);
  }
  return rows.length > 0 ? rows.join("\n") : "该广告系列暂无有效QS记录";
}

export function buildAuxiliaryUserPrompt(dailyStats: CampaignDailyStat[]): string {
  const parts: string[] = [];
  for (const row of aggregateSummaryRows(dailyStats)) {
    parts.push(buildSummaryBlock(row), ``);
  }
  parts.push(
    `【最近 7 天日级数据】`,
    buildDetailedDailyTable(dailyStats),
    ``,
    `【搜索字词明细】`,
    `未提供搜索字词数据`,
    ``,
    `【质量分数据】`,
    buildQualityScoreBlock(dailyStats),
    ``,
    `---`,
    `请根据以上数据，按照提示词要求进行辅助分析，输出结构化门控标签和详细分析报告。`,
  );
  return parts.join("\n");
}

export function parseAuxiliaryGateTags(response: string): string {
  const gateMatch = response.match(/【结构化门控输出（供主决策层读取）】([\s\S]*?)(?=【详细分析】|$)/);
  if (gateMatch) return gateMatch[1].trim();

  const tags: string[] = [];
  const fields = [
    { label: "证据强度", pattern: /证据强度\s*[=：:]\s*(\S+)/ },
    { label: "搜索词纯度状态", pattern: /搜索词纯度状态\s*[=：:]\s*(\S+)/ },
    { label: "日级稳定性状态", pattern: /日级稳定性状态\s*[=：:]\s*(\S+)/ },
    { label: "质量分状态", pattern: /质量分状态\s*[=：:]\s*(\S+)/ },
    { label: "扩量门控", pattern: /扩量门控\s*[=：:]\s*(\S+)/ },
    { label: "辅助风险标签", pattern: /辅助风险标签\s*[=：:]\s*(.+)/ },
  ];
  for (const { label, pattern } of fields) {
    const match = response.match(pattern);
    if (match) tags.push(`- ${label} = ${match[1].trim()}`);
  }
  return tags.length > 0 ? tags.join("\n") : "";
}

export function buildMainDecisionUserPrompt(dailyStats: CampaignDailyStat[], auxiliaryGateTags: string): string {
  const parts: string[] = [];
  for (const row of aggregateSummaryRows(dailyStats)) {
    parts.push(
      `广告系列名：${row.name}`,
      `点击：${row.clicks}`,
      `佣金：${fmtDollar(row.commission)}`,
      `花费：${fmtDollar(row.spend)}`,
      `AVG CPC：${row.avgCpc != null ? fmtDollar(row.avgCpc) : "—"}`,
      `MAX CPC：${fmtDollar(row.maxCpc)}`,
      `订单：${row.orders}`,
      `日预算：${fmtDollar(row.dailyBudget)}`,
      `IS Budget丢失：${fmtPct(row.isBudget)}`,
      `IS Rank丢失：${fmtPct(row.isRank)}`,
      `平均QS：${row.avgQualityScore != null ? row.avgQualityScore.toFixed(1) : "—"}`,
      ``,
    );
  }
  if (auxiliaryGateTags) {
    parts.push(`【结构化门控输出（供主决策层读取）】`, auxiliaryGateTags, ``);
  }
  parts.push(`---`, `请根据以上数据和辅助层门控标签，按照提示词要求进行主决策分析。`);
  return parts.join("\n");
}

interface DetailedAnalysisResult {
  combinedReport: string;
  actionItems: CampaignActionItem[];
  suggestedAction: string;
  reasonSummary: string;
}

const ALL_STRATEGIES: AnalysisStrategy[] = ["balanced", "aggressive", "conservative"];

async function callModel(systemPrompt: string, userPrompt: string): Promise<string> {
  return callAiWithFallback(AI_SCENE, [
    { role: "system", content: systemPrompt },
    { role: "user", content: userPrompt },
  ], AI_MAX_TOKENS);
}

/**
 * 双层详细分析：辅助层跑一轮出门控标签，主决策层三策略各跑一轮。
 * 完整报告 = 三策略主决策结果 + 辅助分析报告；actionItems 取所选策略。
 */
async function runDetailedAnalysis(
  dailyStats: CampaignDailyStat[],
  selectedStrategy: AnalysisStrategy,
  config: AnalysisPromptConfig,
): Promise<DetailedAnalysisResult> {
  const auxiliaryResponse = await callModel(config.auxPrompt, buildAuxiliaryUserPrompt(dailyStats));
  const gateTags = parseAuxiliaryGateTags(auxiliaryResponse);
  const mainUserPrompt = buildMainDecisionUserPrompt(dailyStats, gateTags);

  const strategyResults = new Map<AnalysisStrategy, string>();
  for (const strat of ALL_STRATEGIES) {
    const prompt = extractStrategyPrompt(config.mainPrompt, strat);
    if (!prompt) continue;
    strategyResults.set(strat, await callModel(prompt, mainUserPrompt));
  }

  const selectedResponse = strategyResults.get(selectedStrategy) || strategyResults.get("balanced") || "";

  let actionItems: CampaignActionItem[] = [];
  let suggestedAction = "";
  let reasonSummary = "";
  if (selectedResponse) {
    const decisions = parseBrandSearchResponse(selectedResponse);
    if (decisions.length > 0) {
      const decision = decisions[0];
      const actionType = mapDecisionToActionType(decision.decision);
      const targetValue = parseTargetValue(decision.targetValue);
      const actionItem: CampaignActionItem = { type: actionType, reason: decision.decision };
      if (targetValue != null) actionItem.targetValue = targetValue;
      actionItems = [actionItem];
      suggestedAction = decision.decision;
      reasonSummary = `${decision.decision}${targetValue != null ? `（目标值：$${targetValue.toFixed(2)}）` : ""}`;
    }
  }

  const reportSections: string[] = [];
  for (const strat of ALL_STRATEGIES) {
    const response = strategyResults.get(strat);
    if (!response) continue;
    reportSections.push(`## 主决策结果 — ${ANALYSIS_STRATEGY_LABELS[strat]}`, response.trim(), ``);
  }
  reportSections.push(`---`, ``, `## 辅助分析报告`, auxiliaryResponse.trim());

  return { combinedReport: reportSections.join("\n"), actionItems, suggestedAction, reasonSummary };
}

// ─── 配置与数据读取 ──────────────────────────────────────────────

export const CONFIG_KEYS = {
  mainPrompt: "campaign_ad_analysis_main_prompt",
  auxPrompt: "campaign_ad_analysis_aux_prompt",
  targetRoi: "campaign_ad_analysis_target_roi",
  targetCpa: "campaign_ad_analysis_target_cpa",
} as const;

export async function getAnalysisPromptConfig(): Promise<AnalysisPromptConfig | null> {
  const rows = await prisma.system_configs.findMany({
    where: { config_key: { in: Object.values(CONFIG_KEYS) }, is_deleted: 0 },
    select: { config_key: true, config_value: true },
  });
  const map = new Map(rows.map((r) => [r.config_key, r.config_value || ""]));
  const mainPrompt = (map.get(CONFIG_KEYS.mainPrompt) || "").trim();
  const auxPrompt = (map.get(CONFIG_KEYS.auxPrompt) || "").trim();
  if (!mainPrompt || !auxPrompt) return null;
  return {
    mainPrompt,
    auxPrompt,
    targetRoi: Number(map.get(CONFIG_KEYS.targetRoi)) || 0,
    targetCpa: Number(map.get(CONFIG_KEYS.targetCpa)) || 0,
  };
}

export interface AnalysisDateRange {
  /** YYYY-MM-DD（CST 口径，含） */
  startStr: string;
  endStr: string;
  /** ads_daily_stats.date 的 DATE 列过滤（UTC 午夜对齐） */
  dateStart: Date;
  dateEndExclusive: Date;
}

/** 最近 N 天（截止昨天，CST）——与 kyads 默认 7 天窗一致 */
export function getAnalysisRange(days = 7): AnalysisDateRange {
  const end = nowCST().subtract(1, "day");
  const start = end.subtract(days - 1, "day");
  const startStr = start.format("YYYY-MM-DD");
  const endStr = end.format("YYYY-MM-DD");
  return {
    startStr,
    endStr,
    dateStart: dateColumnStart(startStr),
    dateEndExclusive: dateColumnEndExclusive(endStr),
  };
}

/**
 * D-266 批一：campaigns 表的预算/出价存账户币种；给 AI 的表格与前端明细一律 USD，
 * 这里按 MCC 币种把 campaign 兜底值折美元后再返回。
 * 返回 userId 下这批系列的「账户币种 → USD」乘数（USD 恒 1；汇率不可用时 1 兜底并原样返回）。
 */
export async function getCampaignUsdRates(
  campaignRows: Array<{ id: bigint; mcc_id: bigint | null }>,
): Promise<Map<string, number>> {
  const { getExchangeRate } = await import("@/lib/exchange-rate");
  const { todayCST } = await import("@/lib/date-utils");
  const mccIds = [...new Set(campaignRows.map((c) => c.mcc_id).filter((v): v is bigint => v != null))];
  const rateByCampaign = new Map<string, number>();
  if (mccIds.length === 0) {
    for (const c of campaignRows) rateByCampaign.set(String(c.id), 1);
    return rateByCampaign;
  }
  const mccs = await prisma.google_mcc_accounts.findMany({
    where: { id: { in: mccIds } },
    select: { id: true, currency: true },
  });
  const today = todayCST();
  const rateByMcc = new Map<string, number>();
  for (const m of mccs) {
    const cur = (m.currency || "USD").toUpperCase();
    if (cur === "USD") { rateByMcc.set(String(m.id), 1); continue; }
    const r = await getExchangeRate(cur, today);
    rateByMcc.set(String(m.id), r > 0 ? r : 1);
  }
  for (const c of campaignRows) {
    rateByCampaign.set(String(c.id), c.mcc_id != null ? (rateByMcc.get(String(c.mcc_id)) ?? 1) : 1);
  }
  return rateByCampaign;
}

/** 从 ads_daily_stats + campaigns 读取分析输入（金额均 USD） */
export async function fetchCampaignDailyStats(
  userId: bigint,
  campaignIds: bigint[],
  range: AnalysisDateRange,
): Promise<CampaignDailyStat[]> {
  if (campaignIds.length === 0) return [];
  const [campaigns, stats] = await Promise.all([
    prisma.campaigns.findMany({
      where: { id: { in: campaignIds }, user_id: userId, is_deleted: 0 },
      select: { id: true, campaign_name: true, daily_budget: true, max_cpc_limit: true, mcc_id: true },
    }),
    prisma.ads_daily_stats.findMany({
      where: {
        campaign_id: { in: campaignIds },
        user_id: userId,
        is_deleted: 0,
        date: { gte: range.dateStart, lt: range.dateEndExclusive },
      },
      orderBy: [{ campaign_id: "asc" }, { date: "asc" }],
    }),
  ]);

  // D-266 批一：campaigns 兜底值是账户币种，折美元后再进 AI 表格（stats 侧金额本就是 USD）
  const usdRate = await getCampaignUsdRates(campaigns);

  const campaignMap = new Map(campaigns.map((c) => [String(c.id), c]));
  const result: CampaignDailyStat[] = [];
  for (const s of stats) {
    const c = campaignMap.get(String(s.campaign_id));
    if (!c) continue;
    const rate = usdRate.get(String(c.id)) ?? 1;
    const spend = Number(s.cost || 0);
    const clicks = Number(s.clicks || 0);
    result.push({
      campaignId: String(s.campaign_id),
      campaignName: c.campaign_name || String(s.campaign_id),
      statDate: s.date,
      impressions: Number(s.impressions || 0),
      clicks,
      spend,
      dailyBudget: Number(s.budget || 0) || Number(c.daily_budget || 0) * rate,
      avgCpc: clicks > 0 ? spend / clicks : Number(s.cpc || 0),
      maxCpc: Number(s.max_cpc || 0) || Number(c.max_cpc_limit || 0) * rate,
      isBudget: Number(s.is_budget || 0),
      isRank: Number(s.is_rank || 0),
      orders: Number(s.orders || 0),
      commission: Number(s.commission || 0),
      qualityScore: Number(s.quality_score || 0),
    });
  }
  return result;
}

// ─── 结果落库 ────────────────────────────────────────────────────

function buildScopeKey(days: number, strategy: AnalysisStrategy): string {
  return `${days}d_${strategy}`;
}

interface UpsertArgs {
  userId: bigint;
  campaignId: bigint;
  googleCampaignId: string | null;
  campaignName: string;
  scopeKey: string;
  range: AnalysisDateRange;
  totals: { impressions: number; clicks: number; spend: number; orders: number; commission: number };
  strategy: AnalysisStrategy;
  reasonSummary: string;
  reasonDetail: string;
  actionItems: CampaignActionItem[];
}

async function upsertRecommendation(args: UpsertArgs): Promise<void> {
  const roi = args.totals.spend > 0
    ? (args.totals.commission - args.totals.spend) / args.totals.spend : 0;
  const payload = {
    user_id: args.userId,
    google_campaign_id: args.googleCampaignId,
    campaign_name: args.campaignName.slice(0, 255),
    date_range_start: args.range.dateStart,
    date_range_end: dateColumnStart(args.range.endStr),
    impressions: BigInt(Math.round(args.totals.impressions)),
    clicks: Math.round(args.totals.clicks),
    spend: args.totals.spend,
    orders: Math.round(args.totals.orders),
    commission: args.totals.commission,
    roi,
    recommendation_type: RECOMMENDATION_TYPE,
    strategy: args.strategy,
    reason_summary: args.reasonSummary.slice(0, 500),
    reason_detail: args.reasonDetail,
    action_items: args.actionItems as unknown as object[],
    engine_type: "rule_plus_ai",
    status: "active",
    is_deleted: 0,
  };
  await prisma.ai_recommendations.upsert({
    where: { campaign_id_scope_key: { campaign_id: args.campaignId, scope_key: args.scopeKey } },
    update: payload,
    create: { campaign_id: args.campaignId, scope_key: args.scopeKey, ...payload },
  });
}

// ─── 主入口 ─────────────────────────────────────────────────────

export interface AnalyzeCampaignsInput {
  userId: bigint;
  campaignIds: bigint[];
  strategy?: AnalysisStrategy;
  forceRefresh?: boolean;
  /** 双层详细分析（眼睛弹窗「重新分析」）；false = 快速批量（一键分析/cron） */
  detailed?: boolean;
  days?: number;
}

export async function analyzeCampaigns(
  input: AnalyzeCampaignsInput,
): Promise<{ configured: boolean; items: CampaignAnalysisResultItem[] }> {
  const strategy: AnalysisStrategy = input.strategy || "balanced";
  const days = input.days || 7;
  const range = getAnalysisRange(days);
  const scopeKey = buildScopeKey(days, strategy);
  const idStrs = input.campaignIds.map((id) => String(id));

  const config = await getAnalysisPromptConfig();
  if (!config) {
    return {
      configured: false,
      items: idStrs.map((id) => ({ campaignId: id, status: "not_configured" as const })),
    };
  }

  // 缓存命中：同 scope、同分析截止日、有结构化 actionItems 的即视为新鲜
  const cachedRows = await prisma.ai_recommendations.findMany({
    where: {
      user_id: input.userId,
      campaign_id: { in: input.campaignIds },
      scope_key: scopeKey,
      recommendation_type: RECOMMENDATION_TYPE,
      status: "active",
      is_deleted: 0,
    },
  });
  const expectedEnd = dateColumnStart(range.endStr).getTime();
  const cachedById = new Map(
    cachedRows
      .filter((r) => r.date_range_end.getTime() === expectedEnd && r.action_items != null)
      .map((r) => [String(r.campaign_id), r]),
  );

  if (!input.forceRefresh && idStrs.every((id) => cachedById.has(id))) {
    return {
      configured: true,
      items: idStrs.map((id) => {
        const r = cachedById.get(id)!;
        return {
          campaignId: id,
          status: "cached" as const,
          summary: r.reason_summary,
          detail: r.reason_detail || "",
          suggestedAction: r.reason_summary,
          actionItems: normalizeCampaignActionItems(r.action_items),
          updatedAt: r.updated_at.toISOString(),
        };
      }),
    };
  }

  const dailyStats = await fetchCampaignDailyStats(input.userId, input.campaignIds, range);
  if (dailyStats.length === 0) {
    return {
      configured: true,
      items: idStrs.map((id) => ({
        campaignId: id,
        status: "failed" as const,
        errorMessage: "该时间段内无投放数据",
      })),
    };
  }

  const campaignRows = await prisma.campaigns.findMany({
    where: { id: { in: input.campaignIds }, user_id: input.userId, is_deleted: 0 },
    select: { id: true, campaign_name: true, google_campaign_id: true },
  });
  const campaignInfo = new Map(campaignRows.map((c) => [String(c.id), c]));

  const totalsOf = (id: string) => {
    const rows = dailyStats.filter((s) => s.campaignId === id);
    return {
      impressions: rows.reduce((s, d) => s + d.impressions, 0),
      clicks: rows.reduce((s, d) => s + d.clicks, 0),
      spend: rows.reduce((s, d) => s + d.spend, 0),
      orders: rows.reduce((s, d) => s + d.orders, 0),
      commission: rows.reduce((s, d) => s + d.commission, 0),
    };
  };

  const statIds = new Set(dailyStats.map((s) => s.campaignId));

  // ── 详细模式（单系列重新分析） ──
  if (input.detailed) {
    const items: CampaignAnalysisResultItem[] = [];
    for (const id of idStrs) {
      if (!statIds.has(id)) {
        items.push({ campaignId: id, status: "failed", errorMessage: "该时间段内无投放数据" });
        continue;
      }
      const rows = dailyStats.filter((s) => s.campaignId === id);
      try {
        const result = await runDetailedAnalysis(rows, strategy, config);
        const info = campaignInfo.get(id);
        await upsertRecommendation({
          userId: input.userId,
          campaignId: BigInt(id),
          googleCampaignId: info?.google_campaign_id || null,
          campaignName: info?.campaign_name || rows[0].campaignName,
          scopeKey,
          range,
          totals: totalsOf(id),
          strategy,
          reasonSummary: result.reasonSummary || result.suggestedAction || "分析完成",
          reasonDetail: result.combinedReport,
          actionItems: result.actionItems,
        });
        items.push({
          campaignId: id,
          status: "generated",
          summary: result.reasonSummary,
          detail: result.combinedReport,
          suggestedAction: result.suggestedAction,
          actionItems: result.actionItems,
          updatedAt: new Date().toISOString(),
        });
      } catch (err) {
        items.push({
          campaignId: id,
          status: "failed",
          errorMessage: err instanceof Error ? err.message : "详细分析失败",
        });
      }
    }
    return { configured: true, items };
  }

  // ── 快速批量模式 ──
  const strategyPrompt = extractStrategyPrompt(config.mainPrompt, strategy);
  if (!strategyPrompt) {
    return {
      configured: false,
      items: idStrs.map((id) => ({
        campaignId: id,
        status: "failed" as const,
        errorMessage: `主决策提示词缺少${ANALYSIS_STRATEGY_LABELS[strategy]}分段`,
      })),
    };
  }

  const items: CampaignAnalysisResultItem[] = [];
  const pendingIds = idStrs.filter((id) => {
    // 有缓存且不强刷的直接返回缓存（部分命中场景）
    if (!input.forceRefresh && cachedById.has(id)) {
      const r = cachedById.get(id)!;
      items.push({
        campaignId: id,
        status: "cached",
        summary: r.reason_summary,
        detail: r.reason_detail || "",
        suggestedAction: r.reason_summary,
        actionItems: normalizeCampaignActionItems(r.action_items),
        updatedAt: r.updated_at.toISOString(),
      });
      return false;
    }
    if (!statIds.has(id)) {
      items.push({ campaignId: id, status: "failed", errorMessage: "该时间段内无投放数据" });
      return false;
    }
    return true;
  });

  for (let i = 0; i < pendingIds.length; i += ANALYSIS_BATCH_SIZE) {
    const chunk = pendingIds.slice(i, i + ANALYSIS_BATCH_SIZE);
    const chunkStats = dailyStats.filter((s) => chunk.includes(s.campaignId));
    const userPrompt = buildBatchUserPrompt({
      targetRoi: config.targetRoi,
      targetCpa: config.targetCpa,
      periodLabel: `${days} 天`,
      summaryTable: buildSummaryTable(chunkStats),
      dailyTable: buildDailyTable(chunkStats),
      analyticsInsights: buildAnalyticsInsights(chunkStats) || undefined,
    });

    let decisions: BrandSearchDecision[] = [];
    let chunkError: string | null = null;
    try {
      const raw = await callModel(strategyPrompt, userPrompt);
      decisions = parseBrandSearchResponse(raw);
    } catch (err) {
      chunkError = err instanceof Error ? err.message : "AI 分析失败";
    }

    if (chunkError) {
      for (const id of chunk) {
        items.push({ campaignId: id, status: "failed", errorMessage: chunkError });
      }
      continue;
    }

    // 决策按系列名匹配回 campaignId（精确 → 归一化 → 包含）
    const nameToId = new Map<string, string>();
    for (const id of chunk) {
      const name = campaignInfo.get(id)?.campaign_name
        || chunkStats.find((s) => s.campaignId === id)?.campaignName || id;
      nameToId.set(normalizeCampaignNameForMatch(name), id);
    }
    const decisionById = new Map<string, BrandSearchDecision>();
    for (const d of decisions) {
      const norm = normalizeCampaignNameForMatch(d.campaignName);
      const direct = nameToId.get(norm);
      if (direct) { decisionById.set(direct, d); continue; }
      for (const [n, id] of nameToId) {
        if (n && norm && (n.includes(norm) || norm.includes(n))) {
          decisionById.set(id, d);
          break;
        }
      }
    }
    if (chunk.length === 1 && decisions.length === 1 && !decisionById.has(chunk[0])) {
      decisionById.set(chunk[0], decisions[0]);
    }

    for (const id of chunk) {
      const decision = decisionById.get(id);
      if (!decision) {
        items.push({ campaignId: id, status: "failed", errorMessage: "AI 输出中未找到该广告系列的决策结果" });
        continue;
      }
      const actionType = mapDecisionToActionType(decision.decision);
      const targetValue = parseTargetValue(decision.targetValue);
      const actionItem: CampaignActionItem = { type: actionType, reason: decision.decision };
      if (targetValue != null) actionItem.targetValue = targetValue;
      const reasonSummary = `${decision.decision}${targetValue != null ? `（目标值：$${targetValue.toFixed(2)}）` : ""}`;
      const detail = [
        `## 决策结果`,
        `- **策略：** ${ANALYSIS_STRATEGY_LABELS[strategy]}`,
        `- **最终决策：** ${decision.decision}`,
        `- **目标值：** ${decision.targetValue}`,
      ].join("\n");

      const info = campaignInfo.get(id);
      try {
        await upsertRecommendation({
          userId: input.userId,
          campaignId: BigInt(id),
          googleCampaignId: info?.google_campaign_id || null,
          campaignName: info?.campaign_name || id,
          scopeKey,
          range,
          totals: totalsOf(id),
          strategy,
          reasonSummary,
          reasonDetail: detail,
          actionItems: [actionItem],
        });
      } catch (err) {
        console.warn(`[campaign-analysis] upsert 失败 campaign=${id}:`, err instanceof Error ? err.message : err);
      }

      items.push({
        campaignId: id,
        status: "generated",
        summary: reasonSummary,
        detail,
        suggestedAction: decision.decision,
        actionItems: [actionItem],
        updatedAt: new Date().toISOString(),
      });
    }
  }

  return { configured: true, items };
}

/** 只读缓存（页面加载时展示操作建议列，不触发 AI） */
export async function getCachedRecommendations(
  userId: bigint,
  campaignIds: bigint[],
  strategy: AnalysisStrategy = "balanced",
  days = 7,
): Promise<CampaignAnalysisResultItem[]> {
  if (campaignIds.length === 0) return [];
  const scopeKey = buildScopeKey(days, strategy);
  const rows = await prisma.ai_recommendations.findMany({
    where: {
      user_id: userId,
      campaign_id: { in: campaignIds },
      scope_key: scopeKey,
      recommendation_type: RECOMMENDATION_TYPE,
      status: "active",
      is_deleted: 0,
    },
  });
  return rows.map((r) => ({
    campaignId: String(r.campaign_id),
    status: "cached" as const,
    summary: r.reason_summary,
    detail: r.reason_detail || "",
    suggestedAction: r.reason_summary,
    actionItems: normalizeCampaignActionItems(r.action_items),
    updatedAt: r.updated_at.toISOString(),
  }));
}
