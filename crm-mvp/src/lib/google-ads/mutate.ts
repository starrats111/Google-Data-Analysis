/**
 * Google Ads 修改服务 - 基于 Service Account REST API
 */
import { MccCredentials, queryGoogleAds, mutateGoogleAds, dollarsToMicros } from "./client";

/**
 * 修改广告系列预算
 */
export async function updateCampaignBudget(
  credentials: MccCredentials,
  customerId: string,
  campaignId: string,
  newBudgetDollars: number,
): Promise<{ success: boolean; message: string }> {
  try {
    const results = await queryGoogleAds(credentials, customerId, `
      SELECT campaign.id, campaign.campaign_budget
      FROM campaign
      WHERE campaign.id = ${campaignId}
    `);

    if (results.length === 0) {
      return { success: false, message: "广告系列不存在" };
    }

    const campaign = results[0].campaign as Record<string, unknown> | undefined;
    const budgetResourceName = String(campaign?.campaignBudget ?? campaign?.campaign_budget ?? "");
    if (!budgetResourceName) {
      return { success: false, message: "未找到广告系列预算资源" };
    }

    await mutateGoogleAds(credentials, customerId, [{
      campaign_budget_operation: {
        update: {
          resource_name: budgetResourceName,
          amount_micros: String(dollarsToMicros(newBudgetDollars)),
        },
        update_mask: "amount_micros",
      },
    }]);

    return { success: true, message: `预算已更新为 $${newBudgetDollars}` };
  } catch (err) {
    return { success: false, message: `预算修改失败: ${err instanceof Error ? err.message : String(err)}` };
  }
}

/**
 * 修改广告系列最高 CPC（通过更新广告组出价）
 */
export async function updateCampaignMaxCpc(
  credentials: MccCredentials,
  customerId: string,
  campaignId: string,
  newCpcDollars: number,
): Promise<{ success: boolean; message: string }> {
  try {
    const cid = customerId.replace(/-/g, "");
    const campaignResourceName = `customers/${cid}/campaigns/${campaignId}`;

    const adGroups = await queryGoogleAds(credentials, customerId, `
      SELECT ad_group.id, ad_group.resource_name
      FROM ad_group
      WHERE ad_group.campaign = '${campaignResourceName}'
        AND ad_group.status != 'REMOVED'
    `);

    const ops = adGroups.map((row) => {
      const ag = row.adGroup as Record<string, unknown> | undefined;
      const rn = String(ag?.resourceName ?? ag?.resource_name ?? "");
      return {
        ad_group_operation: {
          update: {
            resource_name: rn,
            cpc_bid_micros: String(dollarsToMicros(newCpcDollars)),
          },
          update_mask: "cpc_bid_micros",
        },
      };
    }).filter((op) => op.ad_group_operation.update.resource_name);

    if (ops.length > 0) {
      await mutateGoogleAds(credentials, customerId, ops);
    }

    return { success: true, message: `CPC 已更新为 $${newCpcDollars}` };
  } catch (err) {
    return { success: false, message: `CPC 修改失败: ${err instanceof Error ? err.message : String(err)}` };
  }
}

/**
 * 移除广告系列（Google Ads remove 操作，不可逆）
 */
export async function removeCampaign(
  credentials: MccCredentials,
  customerId: string,
  campaignId: string,
): Promise<{ success: boolean; message: string }> {
  try {
    const cid = customerId.replace(/-/g, "");
    const resourceName = `customers/${cid}/campaigns/${campaignId}`;

    await mutateGoogleAds(credentials, customerId, [{
      campaign_operation: {
        remove: resourceName,
      },
    }]);

    return { success: true, message: "广告系列已从 Google Ads 移除" };
  } catch (err) {
    return { success: false, message: `移除失败: ${err instanceof Error ? err.message : String(err)}` };
  }
}

/**
 * 暂停/启用广告系列
 */
export async function updateCampaignStatus(
  credentials: MccCredentials,
  customerId: string,
  campaignId: string,
  newStatus: "ENABLED" | "PAUSED",
): Promise<{ success: boolean; message: string }> {
  try {
    const cid = customerId.replace(/-/g, "");
    const resourceName = `customers/${cid}/campaigns/${campaignId}`;

    await mutateGoogleAds(credentials, customerId, [{
      campaign_operation: {
        update: {
          resource_name: resourceName,
          status: newStatus,
        },
        update_mask: "status",
      },
    }]);

    return { success: true, message: `广告系列状态已更新为 ${newStatus}` };
  } catch (err) {
    return { success: false, message: `状态修改失败: ${err instanceof Error ? err.message : String(err)}` };
  }
}
