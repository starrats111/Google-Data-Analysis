import { NextRequest } from "next/server";
import { getUserFromRequest, serializeData } from "@/lib/auth";
import { apiSuccess, apiError } from "@/lib/constants";
import prisma from "@/lib/prisma";

/**
 * POST /api/user/data-center/update-campaign
 * 通过 Google Ads API 修改预算或 CPC - Service Account 认证
 */
export async function POST(req: NextRequest) {
  const user = getUserFromRequest(req);
  if (!user) return apiError("未授权", 401);

  const { campaign_id, field, value } = await req.json();
  if (!campaign_id) return apiError("缺少 campaign_id", 400);
  if (!field || !["budget", "max_cpc"].includes(field)) return apiError("field 必须是 budget 或 max_cpc", 400);
  if (value === undefined || value === null || value < 0) return apiError("value 必须是非负数", 400);

  const userId = BigInt(user.userId);

  const campaign = await prisma.campaigns.findFirst({
    where: { id: BigInt(campaign_id), user_id: userId, is_deleted: 0 },
  });
  if (!campaign) return apiError("广告系列不存在", 404);
  if (!campaign.google_campaign_id) return apiError("广告系列未关联 Google Ads", 400);
  if (!campaign.mcc_id) return apiError("广告系列未关联 MCC 账户", 400);

  const mcc = await prisma.google_mcc_accounts.findFirst({
    where: { id: campaign.mcc_id, user_id: userId, is_deleted: 0 },
  });
  if (!mcc) return apiError("广告系列关联的 MCC 账户不存在", 404);
  if (!mcc.service_account_json) return apiError("MCC 未配置服务账号凭证", 400);
  if (!mcc.developer_token) return apiError(`MCC「${mcc.mcc_name || mcc.mcc_id}」未配置 developer_token，请在「个人设置 → MCC 管理」中编辑该 MCC 填写 Developer Token`, 400);

  try {
    const { updateCampaignBudget, updateCampaignMaxCpc } = await import("@/lib/google-ads");
    const credentials = { mcc_id: mcc.mcc_id, developer_token: mcc.developer_token, service_account_json: mcc.service_account_json };

    let result: { success: boolean; message: string };

    if (field === "budget") {
      result = await updateCampaignBudget(credentials, campaign.customer_id || "", campaign.google_campaign_id, value);
      if (result.success) {
        await prisma.campaigns.update({ where: { id: campaign.id }, data: { daily_budget: value } });
      }
    } else {
      result = await updateCampaignMaxCpc(credentials, campaign.customer_id || "", campaign.google_campaign_id, value);
      if (result.success) {
        await prisma.campaigns.update({ where: { id: campaign.id }, data: { max_cpc_limit: value } });
      }
    }

    if (!result.success) return apiError(result.message, 500);

    const updated = await prisma.campaigns.findUnique({ where: { id: campaign.id } });
    return apiSuccess(serializeData({ campaign: updated, message: result.message }));
  } catch (err) {
    return apiError(`修改失败: ${err instanceof Error ? err.message : String(err)}`, 500);
  }
}
