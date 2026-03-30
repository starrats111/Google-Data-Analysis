/**
 * Google Ads 广告系列状态实时同步
 * 从 Google Ads API 拉取最新 campaign 状态/预算，更新到数据库
 */
import prisma from "@/lib/prisma";

interface SyncResult {
  mcc: string;
  campaigns: number;
  updated: number;
  error?: string;
}

/**
 * 同步指定用户所有 MCC 下的广告系列状态
 */
export async function syncUserCampaignStatuses(userId: bigint): Promise<SyncResult[]> {
  const mccs = await prisma.google_mcc_accounts.findMany({
    where: { user_id: userId, is_deleted: 0, is_active: 1 },
  });

  const results: SyncResult[] = [];

  for (const mcc of mccs) {
    if (!mcc.service_account_json || !mcc.developer_token) continue;

    try {
      const { fetchAllCampaignStatuses } = await import("@/lib/google-ads");
      const credentials = {
        mcc_id: mcc.mcc_id,
        developer_token: mcc.developer_token,
        service_account_json: mcc.service_account_json,
      };

      const cids = await prisma.mcc_cid_accounts.findMany({
        where: {
          mcc_account_id: mcc.id,
          is_deleted: 0,
          status: "active",
          is_available: { not: "D" },
        },
      });
      if (cids.length === 0) continue;

      const customerIds = cids.map((c) => c.customer_id);
      const { statuses, disabledCids } = await fetchAllCampaignStatuses(credentials, customerIds);
      let updated = 0;

      if (disabledCids.length > 0) {
        const r = await prisma.campaigns.updateMany({
          where: { user_id: userId, customer_id: { in: disabledCids }, is_deleted: 0, google_status: { not: "PAUSED" } },
          data: { google_status: "PAUSED", last_google_sync_at: new Date() },
        });
        updated += r.count;
        await prisma.mcc_cid_accounts.updateMany({
          where: { mcc_account_id: mcc.id, customer_id: { in: disabledCids } },
          data: { is_available: "D", last_synced_at: new Date() },
        });
      }

      // 逐条更新状态（不覆盖 campaign_name）
      for (const s of statuses) {
        const result = await prisma.campaigns.updateMany({
          where: { user_id: userId, google_campaign_id: s.campaign_id, is_deleted: 0 },
          data: { google_status: s.status, last_google_sync_at: new Date() },
        });
        updated += result.count;
      }

      // 更新 CID 可用状态
      const cidHasEnabled = new Map<string, boolean>();
      for (const s of statuses) {
        if (s.status === "ENABLED") cidHasEnabled.set(s.customer_id, true);
        else if (!cidHasEnabled.has(s.customer_id)) cidHasEnabled.set(s.customer_id, false);
      }
      for (const [customerId, hasEnabled] of cidHasEnabled) {
        await prisma.mcc_cid_accounts.updateMany({
          where: { mcc_account_id: mcc.id, customer_id: customerId },
          data: { is_available: hasEnabled ? "N" : "Y", last_synced_at: new Date() },
        });
      }

      results.push({ mcc: mcc.mcc_name || mcc.mcc_id, campaigns: statuses.length, updated });
    } catch (e) {
      results.push({ mcc: mcc.mcc_name || mcc.mcc_id, campaigns: 0, updated: 0, error: e instanceof Error ? e.message : String(e) });
    }
  }

  return results;
}
