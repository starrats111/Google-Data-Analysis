import { NextRequest } from "next/server";
import { getUserFromRequest, serializeData } from "@/lib/auth";
import { apiSuccess, apiError } from "@/lib/constants";
import prisma from "@/lib/prisma";
import { removeCampaign } from "@/lib/google-ads";
import { generateCampaignName, resolvePlatformLabel } from "@/lib/campaign-naming";

/**
 * POST /api/user/ad-creation/republish
 * 重新发布广告系列：移除旧的 Google Ads 广告 → 重新生成名称 → 重置本地记录 → 可重新提交
 */
export async function POST(req: NextRequest) {
  const user = getUserFromRequest(req);
  if (!user) return apiError("未授权", 401);

  const body = await req.json();
  const { campaign_id } = body;
  if (!campaign_id) return apiError("缺少 campaign_id");

  const userId = BigInt(user.userId);

  const campaign = await prisma.campaigns.findFirst({
    where: { id: BigInt(campaign_id), user_id: userId, is_deleted: 0 },
  });
  if (!campaign) return apiError("广告系列不存在", 404);
  if (!campaign.google_campaign_id) return apiError("该广告系列尚未提交到 Google Ads，无需重新发布");

  // 1. 移除 Google Ads 上的旧广告
  const mccAccount = campaign.mcc_id
    ? await prisma.google_mcc_accounts.findFirst({ where: { id: campaign.mcc_id, is_deleted: 0 } })
    : null;

  if (mccAccount && campaign.customer_id && mccAccount.service_account_json && mccAccount.developer_token) {
    const credentials = {
      mcc_id: mccAccount.mcc_id,
      developer_token: mccAccount.developer_token,
      service_account_json: mccAccount.service_account_json,
    };

    const result = await removeCampaign(credentials, campaign.customer_id, campaign.google_campaign_id);
    if (!result.success) {
      console.error("[Republish] 移除旧广告失败:", result.message);
    }
  }

  // 2. 重新生成正确的广告系列名称
  const merchant = await prisma.user_merchants.findFirst({
    where: { id: campaign.user_merchant_id, is_deleted: 0 },
    select: { platform: true, merchant_name: true, merchant_id: true, platform_connection_id: true },
  });

  const adSettings = await prisma.ad_default_settings.findFirst({
    where: { user_id: userId, is_deleted: 0 },
  });

  let newCampaignName = campaign.campaign_name;
  if (merchant) {
    const platLabel = await resolvePlatformLabel(userId, merchant.platform || "", merchant.platform_connection_id);
    newCampaignName = await generateCampaignName(
      userId,
      platLabel,
      merchant.merchant_name || "",
      campaign.target_country || "US",
      merchant.merchant_id || "",
      adSettings?.naming_rule || "global",
      undefined,
      undefined,
      campaign.mcc_id,
      campaign.id,
    );
  }

  // 3. 重置本地记录
  await prisma.campaigns.update({
    where: { id: campaign.id },
    data: {
      google_campaign_id: null,
      customer_id: null,
      google_status: "ENABLED",
      campaign_name: newCampaignName,
    },
  });

  const adGroup = await prisma.ad_groups.findFirst({
    where: { campaign_id: campaign.id, is_deleted: 0 },
  });
  if (adGroup) {
    await prisma.ad_groups.update({
      where: { id: adGroup.id },
      data: {
        google_ad_group_id: null,
        ad_group_name: `${merchant?.merchant_name || "Campaign"} - AdGroup`,
      },
    });
  }

  // 广告状态变更，同步商家状态（强关联）
  try {
    const { syncMerchantStatusForUser } = await import("@/lib/campaign-merchant-link");
    await syncMerchantStatusForUser(userId);
  } catch (syncErr) {
    console.error("[Republish] 商家状态同步失败:", syncErr);
  }

  return apiSuccess(serializeData({
    campaign_id: campaign.id,
    campaign_name: newCampaignName,
  }), "旧广告已移除，名称已更新，可重新提交发布");
}
