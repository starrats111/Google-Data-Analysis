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
): Promise<{ customer_id: string; campaign_id: string; status: string; name: string; budget_micros: number; budget_dollars: number }[]> {
  const all: { customer_id: string; campaign_id: string; status: string; name: string; budget_micros: number; budget_dollars: number }[] = [];
  for (const cid of customerIds) {
    try {
      const results = await queryGoogleAds(credentials, cid, `
        SELECT campaign.id, campaign.name, campaign.status, campaign_budget.amount_micros
        FROM campaign
      `);
      for (const r of results) {
        const c = r.campaign as Record<string, unknown> | undefined;
        const budget = r.campaignBudget as Record<string, unknown> | undefined;
        const budgetMicros = Number(budget?.amountMicros ?? 0);
        all.push({
          customer_id: cid.replace(/-/g, ""),
          campaign_id: String(c?.id ?? ""),
          status: String(c?.status ?? "UNKNOWN"),
          name: String(c?.name ?? ""),
          budget_micros: budgetMicros,
          budget_dollars: microsToDollars(budgetMicros),
        });
      }
    } catch (err) {
      console.error(`查询 CID ${cid} 失败:`, err);
    }
  }
  return all;
}
