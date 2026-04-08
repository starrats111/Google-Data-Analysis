import { NextRequest } from "next/server";
import { getUserFromRequest, serializeData } from "@/lib/auth";
import { apiSuccess, apiError } from "@/lib/constants";
import prisma from "@/lib/prisma";

/**
 * POST /api/user/data-center/sync-status
 * 从 Google Ads API 同步所有 campaign 状态
 * 更新 campaigns.google_status 和 mcc_cid_accounts.is_available
 * Body: { mcc_account_id: number }
 */
export async function POST(req: NextRequest) {
  const user = getUserFromRequest(req);
  if (!user) return apiError("未授权", 401);

  const body = await req.json();
  const { mcc_account_id } = body;

  if (!mcc_account_id) return apiError("缺少 mcc_account_id", 400);

  const userId = BigInt(user.userId);

  const mcc = await prisma.google_mcc_accounts.findFirst({
    where: { id: BigInt(mcc_account_id), user_id: userId, is_deleted: 0 },
  });
  if (!mcc) return apiError("MCC 账户不存在", 404);
  if (!mcc.service_account_json) return apiError("MCC 未配置服务账号凭证", 400);

  try {
    const { fetchAllCampaignStatuses } = await import("@/lib/google-ads");

    const credentials = {
      mcc_id: mcc.mcc_id,
      developer_token: mcc.developer_token || "",
      service_account_json: mcc.service_account_json,
    };

    const cids = await prisma.mcc_cid_accounts.findMany({
      where: { mcc_account_id: BigInt(mcc_account_id), is_deleted: 0, status: "active" },
    });

    const customerIds = cids.map((c) => c.customer_id);
    const { statuses, disabledCids } = await fetchAllCampaignStatuses(credentials, customerIds);

    let campaignUpdated = 0;
    let cidUpdated = 0;

    // 对于被停用的 CID，将其下所有 campaign 标记为 PAUSED
    if (disabledCids.length > 0) {
      const r = await prisma.campaigns.updateMany({
        where: { user_id: userId, customer_id: { in: disabledCids }, is_deleted: 0, google_status: { not: "PAUSED" } },
        data: { google_status: "PAUSED", last_google_sync_at: new Date() },
      });
      campaignUpdated += r.count;
    }

    // 更新 campaigns 表
    for (const s of statuses) {
      const result = await prisma.campaigns.updateMany({
        where: {
          user_id: userId,
          google_campaign_id: s.campaign_id,
          is_deleted: 0,
        },
        data: {
          google_status: s.status,
          campaign_name: s.name,
          last_google_sync_at: new Date(),
        },
      });
      campaignUpdated += result.count;
    }

    // 更新 CID 可用状态
    // 先收集每个 CID 下是否有 ENABLED 的 campaign
    const cidHasEnabled = new Map<string, boolean>();
    for (const s of statuses) {
      if (s.status === "ENABLED") {
        cidHasEnabled.set(s.customer_id, true);
      } else if (!cidHasEnabled.has(s.customer_id)) {
        cidHasEnabled.set(s.customer_id, false);
      }
    }

    for (const [customerId, hasEnabled] of cidHasEnabled) {
      const result = await prisma.mcc_cid_accounts.updateMany({
        where: {
          mcc_account_id: BigInt(mcc_account_id),
          customer_id: customerId,
        },
        data: {
          is_available: hasEnabled ? "N" : "Y",
          last_synced_at: new Date(),
        },
      });
      cidUpdated += result.count;
    }

    // 没有任何 campaign 的 CID 标记为可用
    for (const cid of cids) {
      if (!cidHasEnabled.has(cid.customer_id)) {
        await prisma.mcc_cid_accounts.update({
          where: { id: cid.id },
          data: { is_available: "Y", last_synced_at: new Date() },
        });
        cidUpdated++;
      }
    }

    // 广告状态变更后立即同步商家状态（强关联）
    const { syncMerchantStatusForUser } = await import("@/lib/campaign-merchant-link");
    const { linked, merchantsUpdated: merchantUpdated } = await syncMerchantStatusForUser(userId);

    return apiSuccess(serializeData({
      campaignUpdated,
      cidUpdated,
      merchantUpdated,
      totalStatuses: statuses.length,
      message: `状态同步完成：${campaignUpdated} 个广告系列，${cidUpdated} 个 CID，${merchantUpdated} 个商家已更新`,
    }));
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return apiError(`状态同步失败: ${message}`, 500);
  }
}
