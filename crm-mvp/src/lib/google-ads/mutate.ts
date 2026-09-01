/**
 * Google Ads 修改服务 - 基于 Service Account REST API
 */
import { MccCredentials, queryGoogleAds, mutateGoogleAds, dollarsToMicros } from "./client";

/**
 * 修改广告系列预算。
 * ⚠️ D-266 批一口径：newBudgetAccount 是**账户币种**金额（micros = 数值×1e6，单位由账户币种决定）。
 * 美元意图值必须先经 usdToAccountCurrency 换算，本函数不做任何汇率处理。
 */
export async function updateCampaignBudget(
  credentials: MccCredentials,
  customerId: string,
  campaignId: string,
  newBudgetAccount: number,
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
          amount_micros: String(dollarsToMicros(newBudgetAccount)),
        },
        update_mask: "amount_micros",
      },
    }]);

    return { success: true, message: `预算已更新为 ${newBudgetAccount}（账户币种）` };
  } catch (err) {
    return { success: false, message: `预算修改失败: ${err instanceof Error ? err.message : String(err)}` };
  }
}

/**
 * 自动出价策略里「每次点击费用出价上限」所在的字段容器（GAQL/REST 字段名）。
 * TARGET_SPEND 就是界面上的「尽可能争取更多点击次数」(MAXIMIZE_CLICKS)。
 */
const CEILING_CONTAINER: Record<string, string> = {
  TARGET_SPEND: "target_spend",
  PERCENT_CPC: "percent_cpc",
};

/**
 * 修改广告系列的「最高每次点击出价」。
 *
 * D-304：出价上限存在哪个字段，取决于出价策略——不认策略就改不到正确的地方。
 *   · TARGET_SPEND / PERCENT_CPC（自动出价）→ campaign.<策略>.cpc_bid_ceiling_micros
 *   · MANUAL_CPC（手动出价）→ ad_group.cpc_bid_micros
 *   · 其余（MAXIMIZE_CONVERSIONS 等）→ 压根没有 CPC 上限这个概念
 *
 * 病根：本函数原先无条件改 ad_group.cpc_bid_micros。自动出价策略下 Google 收下即忽略，
 * 是一次**静默空操作**，CRM 却照样把新值写进 campaigns.max_cpc_limit 并回「已更新」——
 * 线上 2007 条在投系列 100% 是 MAXIMIZE_CLICKS，等于每一次调价都只改了个数据库字段。
 * 现在按策略分派，改不到的一律如实失败，绝不再报假成功。
 *
 * ⚠️ D-266 批一口径：newCpcAccount 是**账户币种**金额，同 updateCampaignBudget。
 */
export async function updateCampaignMaxCpc(
  credentials: MccCredentials,
  customerId: string,
  campaignId: string,
  newCpcAccount: number,
): Promise<{ success: boolean; message: string }> {
  try {
    const cid = customerId.replace(/-/g, "");
    const campaignResourceName = `customers/${cid}/campaigns/${campaignId}`;
    const micros = String(dollarsToMicros(newCpcAccount));

    const rows = await queryGoogleAds(credentials, customerId, `
      SELECT campaign.id, campaign.bidding_strategy_type, campaign.bidding_strategy
      FROM campaign
      WHERE campaign.id = ${campaignId}
    `);
    if (rows.length === 0) return { success: false, message: "广告系列不存在" };

    const campaign = rows[0].campaign as Record<string, unknown> | undefined;
    const strategy = String(campaign?.biddingStrategyType ?? campaign?.bidding_strategy_type ?? "");
    // 组合出价策略（共享 BiddingStrategy 资源）的上限不在系列上，改系列内联字段会被拒；
    // 这类系列必须去改共享策略本身，CRM 目前不管理共享策略，如实拒绝。
    const portfolio = String(campaign?.biddingStrategy ?? campaign?.bidding_strategy ?? "");
    if (portfolio) {
      return {
        success: false,
        message: `该系列使用共享出价策略（${portfolio.split("/").pop()}），出价上限不在系列上，CRM 无法修改。请在 Google Ads 后台改共享策略。`,
      };
    }

    const container = CEILING_CONTAINER[strategy];
    if (container) {
      await mutateGoogleAds(credentials, customerId, [{
        campaign_operation: {
          update: {
            resource_name: campaignResourceName,
            [container]: { cpc_bid_ceiling_micros: micros },
          },
          update_mask: `${container}.cpc_bid_ceiling_micros`,
        },
      }]);
      return { success: true, message: `出价上限已更新为 ${newCpcAccount}（账户币种）` };
    }

    if (strategy === "MANUAL_CPC") {
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
            update: { resource_name: rn, cpc_bid_micros: micros },
            update_mask: "cpc_bid_micros",
          },
        };
      }).filter((op) => op.ad_group_operation.update.resource_name);

      // 没有广告组 = 没有任何地方承载这个出价，报成功就是骗人
      if (ops.length === 0) return { success: false, message: "该系列下没有可修改出价的广告组" };

      await mutateGoogleAds(credentials, customerId, ops);
      return { success: true, message: `CPC 已更新为 ${newCpcAccount}（账户币种）` };
    }

    return {
      success: false,
      message: `出价策略 ${strategy || "未知"} 没有「每次点击费用出价上限」可设，CRM 未做任何修改。`,
    };
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
 * 重命名广告系列（仅改 Google 侧 campaign.name）
 */
export async function renameCampaign(
  credentials: MccCredentials,
  customerId: string,
  campaignId: string,
  newName: string,
): Promise<{ success: boolean; message: string }> {
  try {
    const cid = customerId.replace(/-/g, "");
    const resourceName = `customers/${cid}/campaigns/${campaignId}`;

    await mutateGoogleAds(credentials, customerId, [{
      campaign_operation: {
        update: {
          resource_name: resourceName,
          name: newName,
        },
        update_mask: "name",
      },
    }]);

    return { success: true, message: `广告系列已重命名为 ${newName}` };
  } catch (err) {
    return { success: false, message: `重命名失败: ${err instanceof Error ? err.message : String(err)}` };
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
