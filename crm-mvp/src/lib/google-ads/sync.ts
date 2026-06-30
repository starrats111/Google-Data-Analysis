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

export async function fetchAllCampaignStatuses(
  credentials: MccCredentials,
  customerIds: string[],
): Promise<{ statuses: { customer_id: string; campaign_id: string; status: string; name: string; budget_micros: number; budget_dollars: number }[]; disabledCids: string[]; credentialDeniedCids: string[] }> {
  const all: { customer_id: string; campaign_id: string; status: string; name: string; budget_micros: number; budget_dollars: number }[] = [];
  const disabledCids: string[] = [];
  // 因「我方凭据/授权」问题查询失败的 CID（见 CREDENTIAL_DENIED_ERRORS）。这些 CID 账号本身可能完全正常，
  // 绝不能当作"账号停用"，必须保持原状——否则一次 MCC service account 失权会误杀整批正常 CID。
  const credentialDeniedCids: string[] = [];

  // ① 账号「确实被停用/中止/未启用」：账号状态层面不可用，可据此把 CID 标记为不可用并暂停其广告。
  const ACCOUNT_DISABLED_ERRORS = [
    "CUSTOMER_NOT_ENABLED",
    "not yet enabled",
    "未启用或已停用",                 // client.ts 仅在 CUSTOMER_NOT_ENABLED / deactivated 时才抛此中文信息
    "ACCOUNT_SUSPENDED",             // 账号被 Google 中止（政策违规等）
    "account has been suspended",    // Google Ads 政策邮件标准措辞
    "UNACCEPTABLE_BUSINESS_PRACTICES", // 不可接受的商业行为
  ];
  // ② 我方「凭据/授权」问题（service account 无访问权、login-customer-id 缺失/不匹配、OAuth 凭证失效）：
  //    属于 CRM 侧问题，账号本身可能正常。绝不能据此判定账号停用，否则一次 MCC 凭据失效就会把该 MCC 下
  //    全部正常 CID 误标不可用、把在投广告全部误暂停。此类 CID 保持原状，仅记录告警，待凭据修复后下轮同步自愈。
  const CREDENTIAL_DENIED_ERRORS = [
    "USER_PERMISSION_DENIED",
    "PERMISSION_DENIED",
    "The caller does not have permission",
    "login-customer-id",
    "invalid_client",                // OAuth 凭证失效（SA/token 配置问题），非账号停用
  ];

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
      const normCid = cid.replace(/-/g, "");
      // 先判定真·账号停用，再判定我方凭据/授权问题（两类错误信息互不重叠）。
      if (ACCOUNT_DISABLED_ERRORS.some(e => msg.includes(e))) {
        disabledCids.push(normCid);
      } else if (CREDENTIAL_DENIED_ERRORS.some(e => msg.includes(e))) {
        credentialDeniedCids.push(normCid);
      } else {
        console.error(`查询 CID ${cid} 失败:`, err);
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

  if (credentialDeniedCids.length > 0) {
    console.warn(
      `[StatusSync] ${credentialDeniedCids.length} 个 CID 因「凭据/权限」错误无法访问` +
      `（疑似 MCC service account 失权或 login-customer-id 配置问题，账号本身可能正常），` +
      `已跳过并保持原状，不标记为停用、不暂停广告：${credentialDeniedCids.join(", ")}`
    );
  }

  return { statuses: all, disabledCids, credentialDeniedCids };
}
