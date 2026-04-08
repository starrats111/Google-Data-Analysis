/**
 * Google Ads 广告系列状态实时同步
 * 从 Google Ads API 拉取最新 campaign 状态/预算，更新到数据库
 *
 * 扩展功能（F-05.1）：
 * - 发现 Google Ads 中存在但 DB 中未记录的新广告系列，自动入库
 * - 同步完成后调用 syncMerchantStatusForUser，商家状态强关联广告系列状态
 */
import prisma from "@/lib/prisma";
import { parseCampaignNameFull, syncMerchantStatusForUser } from "@/lib/campaign-merchant-link";

interface SyncResult {
  mcc: string;
  campaigns: number;
  updated: number;
  new_campaigns: number;
  error?: string;
}

/**
 * 同步指定用户所有 MCC 下的广告系列状态
 *
 * 流程：
 * 1. 从 Google Ads API 拉取所有 CID 下的广告系列列表和状态
 * 2. 对 DB 中已有的广告系列：更新 google_status / budget
 * 3. 对 Google 中有但 DB 中没有的广告系列：自动创建 DB 记录
 * 4. 调用 syncMerchantStatusForUser 自动关联 + 强制同步商家状态
 */
export async function syncUserCampaignStatuses(userId: bigint): Promise<SyncResult[]> {
  const mccs = await prisma.google_mcc_accounts.findMany({
    where: { user_id: userId, is_deleted: 0, is_active: 1 },
  });

  const results: SyncResult[] = [];
  let anyChange = false;

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
      let newCampaigns = 0;

      // ── 1. 处理被停用的 CID ──────────────────────────────────────────────
      if (disabledCids.length > 0) {
        const r = await prisma.campaigns.updateMany({
          where: {
            user_id: userId,
            customer_id: { in: disabledCids },
            is_deleted: 0,
            google_status: { not: "PAUSED" },
          },
          data: { google_status: "PAUSED", last_google_sync_at: new Date() },
        });
        updated += r.count;
        await prisma.mcc_cid_accounts.updateMany({
          where: { mcc_account_id: mcc.id, customer_id: { in: disabledCids } },
          data: { is_available: "D", last_synced_at: new Date() },
        });
      }

      // ── 2. 加载该 MCC 下所有已存在的广告系列，构建索引 ─────────────────
      const existingCampaigns = await prisma.campaigns.findMany({
        where: { user_id: userId, mcc_id: mcc.id, is_deleted: 0 },
        select: {
          id: true,
          google_campaign_id: true,
          google_status: true,
          customer_id: true,
          campaign_name: true,
        },
      });
      const campaignMap = new Map(
        existingCampaigns.map((c) => [c.google_campaign_id, c])
      );

      // ── 3. 更新已有广告状态 / 创建新广告 ──────────────────────────────────
      for (const s of statuses) {
        const existing = campaignMap.get(s.campaign_id);

        if (existing) {
          // 更新状态（不覆盖 campaign_name，防止冲突）
          const needsUpdate =
            existing.google_status !== s.status ||
            (!existing.customer_id && s.customer_id);
          if (needsUpdate) {
            const updateData: Record<string, unknown> = {
              google_status: s.status,
              last_google_sync_at: new Date(),
            };
            if (!existing.customer_id && s.customer_id) {
              updateData.customer_id = s.customer_id;
            }
            await prisma.campaigns.update({
              where: { id: existing.id },
              data: updateData,
            });
            updated++;
          }
        } else {
          // Google Ads 中存在但 DB 中没有 → 员工自建广告，自动入库
          const parsed = parseCampaignNameFull(s.name);
          await prisma.campaigns.create({
            data: {
              user_id: userId,
              // user_merchant_id 先留 0，由 syncMerchantStatusForUser 补全
              user_merchant_id: BigInt(0),
              google_campaign_id: s.campaign_id,
              mcc_id: mcc.id,
              customer_id: s.customer_id,
              campaign_name: s.name,
              daily_budget: s.budget_dollars,
              target_country: parsed?.country || "US",
              google_status: s.status,
              last_google_sync_at: new Date(),
            },
          });
          newCampaigns++;
          anyChange = true;
          console.log(
            `[StatusSync] 发现并入库新广告系列: "${s.name}"` +
            ` (campaign_id=${s.campaign_id}, cid=${s.customer_id})`
          );
        }
      }

      // ── 4. 更新 CID 可用状态 ───────────────────────────────────────────────
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

      if (updated > 0 || newCampaigns > 0) anyChange = true;

      results.push({
        mcc: mcc.mcc_name || mcc.mcc_id,
        campaigns: statuses.length,
        updated,
        new_campaigns: newCampaigns,
      });
    } catch (e) {
      results.push({
        mcc: mcc.mcc_name || mcc.mcc_id,
        campaigns: 0,
        updated: 0,
        new_campaigns: 0,
        error: e instanceof Error ? e.message : String(e),
      });
    }
  }

  // ── 5. 商家状态强关联同步 ───
  const { linked, merchantsUpdated } = await syncMerchantStatusForUser(userId);
  if (linked > 0 || merchantsUpdated > 0) {
    console.log(
      `[StatusSync] 商家同步：关联 ${linked} 条，状态更新 ${merchantsUpdated} 个`
    );
  }

  return results;
}
