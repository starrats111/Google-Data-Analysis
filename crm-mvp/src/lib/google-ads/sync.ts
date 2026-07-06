/**
 * Google Ads 数据同步服务 - 基于 Service Account REST API
 */
import { MccCredentials, queryGoogleAds, microsToDollars } from "./client";
import { todayCST } from "@/lib/date-utils";

export interface CampaignData {
  campaign_id: string;
  campaign_name: string;
  campaign_status: string;
  budget_micros: number;
  budget_dollars: number;
  cost_micros: number;
  cost_dollars: number;
  clicks: number;
  impressions: number;
  cpc_micros: number;
  cpc_dollars: number;
  conversions: number;
  customer_id: string;
}

function parseCampaignRow(row: Record<string, unknown>, customerId: string): CampaignData {
  const campaign = row.campaign as Record<string, unknown> | undefined;
  const budget = row.campaignBudget as Record<string, unknown> | undefined;
  const metrics = row.metrics as Record<string, unknown> | undefined;

  const costMicros = Number(metrics?.costMicros ?? 0);
  const budgetMicros = Number(budget?.amountMicros ?? 0);
  const cpcMicros = Number(metrics?.averageCpc ?? 0);

  return {
    campaign_id: String(campaign?.id ?? ""),
    campaign_name: String(campaign?.name ?? ""),
    campaign_status: String(campaign?.status ?? "UNKNOWN"),
    budget_micros: budgetMicros,
    budget_dollars: microsToDollars(budgetMicros),
    cost_micros: costMicros,
    cost_dollars: microsToDollars(costMicros),
    clicks: Number(metrics?.clicks ?? 0),
    impressions: Number(metrics?.impressions ?? 0),
    cpc_micros: cpcMicros,
    cpc_dollars: microsToDollars(cpcMicros),
    conversions: Number(metrics?.conversions ?? 0),
    customer_id: customerId.replace(/-/g, ""),
  };
}

/**
 * 拉取"今日"数据 — 用最近2天的 date range 替代 DURING TODAY，
 * 避免 Google 账户时区与 CST 不一致导致日期张冠李戴。
 * 返回值包含 date 字段，调用方应按此日期存储。
 */
export async function fetchTodayCampaignData(
  credentials: MccCredentials,
  customerId: string,
  dateRange?: { startDate: string; endDate: string },
): Promise<(CampaignData & { date: string })[]> {
  const end = dateRange?.endDate || todayCST();
  const start = dateRange?.startDate || end;

  const results = await queryGoogleAds(credentials, customerId, `
    SELECT
      campaign.id, campaign.name, campaign.status,
      campaign_budget.amount_micros,
      metrics.cost_micros, metrics.clicks, metrics.impressions,
      metrics.average_cpc, metrics.conversions,
      segments.date
    FROM campaign
    WHERE segments.date BETWEEN '${start}' AND '${end}'
      AND metrics.cost_micros > 0
  `);
  return results.map((r) => ({
    ...parseCampaignRow(r, customerId),
    date: String((r.segments as Record<string, unknown> | undefined)?.date ?? end),
  }));
}

export async function fetchCampaignDataByDateRange(
  credentials: MccCredentials,
  customerId: string,
  startDate: string,
  endDate: string,
): Promise<(CampaignData & { date: string })[]> {
  const results = await queryGoogleAds(credentials, customerId, `
    SELECT
      campaign.id, campaign.name, campaign.status,
      campaign_budget.amount_micros,
      metrics.cost_micros, metrics.clicks, metrics.impressions,
      metrics.average_cpc, metrics.conversions,
      segments.date
    FROM campaign
    WHERE segments.date BETWEEN '${startDate}' AND '${endDate}'
      AND metrics.cost_micros > 0
  `);
  return results.map((r) => ({
    ...parseCampaignRow(r, customerId),
    date: String((r.segments as Record<string, unknown> | undefined)?.date ?? ""),
  }));
}

/**
 * D-040 v3：显式拉取已 REMOVED 但本期有花费的 campaign。
 * GAQL `FROM campaign` 默认隐式过滤 REMOVED（C-098v3 已证），导致后台删除/重发的旧广告
 * 花费永远进不了 CRM，CRM 总花费与 GAds 后台长期对不齐。本函数显式 `campaign.status='REMOVED'`
 * + `cost_micros>0`，只拉真正花过钱的 REMOVED，避免拉回海量零花费历史广告。
 */
export async function fetchRemovedCampaignData(
  credentials: MccCredentials,
  customerId: string,
  startDate: string,
  endDate: string,
): Promise<(CampaignData & { date: string })[]> {
  const results = await queryGoogleAds(credentials, customerId, `
    SELECT
      campaign.id, campaign.name, campaign.status,
      campaign_budget.amount_micros,
      metrics.cost_micros, metrics.clicks, metrics.impressions,
      metrics.average_cpc, metrics.conversions,
      segments.date
    FROM campaign
    WHERE segments.date BETWEEN '${startDate}' AND '${endDate}'
      AND campaign.status = 'REMOVED'
      AND metrics.cost_micros > 0
  `);
  return results.map((r) => ({
    ...parseCampaignRow(r, customerId),
    date: String((r.segments as Record<string, unknown> | undefined)?.date ?? ""),
  }));
}

// fetchAllCampaignStatuses（对全部 CID 逐个发 GAQL 的全量状态扫描）已删除：
// 它是共享 Developer Token explorer 配额被打爆的主因。广告系列状态一律改从
// Google Sheet CampaignInfo 读取（见 @/lib/sheet-status-sync），禁止再回到 API 全量扫描。
