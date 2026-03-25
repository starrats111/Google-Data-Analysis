/**
 * Google Ads 数据同步服务 - 基于 Service Account REST API
 */
import { MccCredentials, queryGoogleAds, microsToDollars } from "./client";

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

export async function fetchTodayCampaignData(
  credentials: MccCredentials,
  customerId: string,
): Promise<CampaignData[]> {
  const results = await queryGoogleAds(credentials, customerId, `
    SELECT
      campaign.id, campaign.name, campaign.status,
      campaign_budget.amount_micros,
      metrics.cost_micros, metrics.clicks, metrics.impressions,
      metrics.average_cpc, metrics.conversions
    FROM campaign
    WHERE segments.date DURING TODAY
      AND campaign.status != 'REMOVED'
  `);
  return results.map((r) => parseCampaignRow(r, customerId));
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
      AND campaign.status != 'REMOVED'
  `);
  return results.map((r) => ({
    ...parseCampaignRow(r, customerId),
    date: String((r.segments as Record<string, unknown> | undefined)?.date ?? ""),
  }));
}

export async function fetchAllCampaignStatuses(
  credentials: MccCredentials,
  customerIds: string[],
): Promise<{ statuses: { customer_id: string; campaign_id: string; status: string; name: string; budget_micros: number; budget_dollars: number }[]; disabledCids: string[] }> {
  const all: { customer_id: string; campaign_id: string; status: string; name: string; budget_micros: number; budget_dollars: number }[] = [];
  const disabledCids: string[] = [];

  const fetchOne = async (cid: string) => {
    try {
      const results = await queryGoogleAds(credentials, cid, `
        SELECT campaign.id, campaign.name, campaign.status, campaign_budget.amount_micros
        FROM campaign
      `);
      return results.map((r) => {
        const c = r.campaign as Record<string, unknown> | undefined;
        const budget = r.campaignBudget as Record<string, unknown> | undefined;
        const budgetMicros = Number(budget?.amountMicros ?? 0);
        return {
          customer_id: cid.replace(/-/g, ""),
          campaign_id: String(c?.id ?? ""),
          status: String(c?.status ?? "UNKNOWN"),
          name: String(c?.name ?? ""),
          budget_micros: budgetMicros,
          budget_dollars: microsToDollars(budgetMicros),
        };
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`查询 CID ${cid} 失败:`, err);
      // CID 被停用/未启用时，标记为 disabled
      if (msg.includes("CUSTOMER_NOT_ENABLED") || msg.includes("not yet enabled")) {
        disabledCids.push(cid.replace(/-/g, ""));
      }
      return [];
    }
  };

  const CONCURRENCY = 5;
  for (let i = 0; i < customerIds.length; i += CONCURRENCY) {
    const batch = customerIds.slice(i, i + CONCURRENCY);
    const results = await Promise.all(batch.map(fetchOne));
    for (const items of results) all.push(...items);
  }

  return { statuses: all, disabledCids };
}
