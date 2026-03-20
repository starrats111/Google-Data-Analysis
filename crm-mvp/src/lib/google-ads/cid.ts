/**
 * CID 管理服务 - 基于 Service Account REST API
 */
import { MccCredentials, queryGoogleAds } from "./client";

interface CidInfo {
  customer_id: string;
  customer_name: string;
  status: string;
}

/**
 * 从 MCC 下拉取所有子账户 CID 列表
 */
export async function listMccChildAccounts(
  credentials: MccCredentials,
): Promise<CidInfo[]> {
  const results = await queryGoogleAds(credentials, credentials.mcc_id, `
    SELECT
      customer_client.id,
      customer_client.descriptive_name,
      customer_client.status,
      customer_client.manager
    FROM customer_client
    WHERE customer_client.manager = false
      AND customer_client.status = 'ENABLED'
  `);

  return results.map((row) => {
    const cc = row.customerClient as Record<string, unknown> | undefined;
    return {
      customer_id: String(cc?.id ?? ""),
      customer_name: String(cc?.descriptiveName ?? ""),
      status: String(cc?.status ?? "ENABLED"),
    };
  });
}

/**
 * 检查 CID 是否可用（无 ENABLED campaign）
 */
export async function checkCidAvailability(
  credentials: MccCredentials,
  customerId: string,
): Promise<boolean> {
  const results = await queryGoogleAds(credentials, customerId, `
    SELECT campaign.id, campaign.status
    FROM campaign
    WHERE campaign.status = 'ENABLED'
    LIMIT 1
  `);
  return results.length === 0;
}
