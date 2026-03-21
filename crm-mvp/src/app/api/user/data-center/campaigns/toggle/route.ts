import { NextRequest } from "next/server";
import { getUserFromRequest, serializeData } from "@/lib/auth";
import { apiSuccess, apiError } from "@/lib/constants";
import prisma from "@/lib/prisma";

/**
 * POST /api/user/data-center/campaigns/toggle
 * 切换广告系列状态（启用 ↔ 暂停）- Service Account 认证
 */
export async function POST(req: NextRequest) {
  const user = getUserFromRequest(req);
  if (!user) return apiError("未授权", 401);

  const { campaign_id, action } = await req.json();
  if (!campaign_id) return apiError("缺少 campaign_id");
  if (!["enable", "pause"].includes(action)) return apiError("action 必须是 enable 或 pause");

  const campaign = await prisma.campaigns.findFirst({
    where: { id: BigInt(campaign_id), user_id: BigInt(user.userId), is_deleted: 0 },
  });
  if (!campaign) return apiError("广告系列不存在", 404);
  if (!campaign.google_campaign_id) return apiError("该广告系列尚未提交到 Google Ads");
  if (!campaign.mcc_id) return apiError("该广告系列未关联 MCC 账户");

  const mcc = await prisma.google_mcc_accounts.findFirst({
    where: { id: campaign.mcc_id, is_deleted: 0 },
  });
  if (!mcc) return apiError("MCC 账户不存在");
  if (!mcc.service_account_json) return apiError("MCC 未配置凭证");
  if (!mcc.developer_token) return apiError(`MCC「${mcc.mcc_name || mcc.mcc_id}」未配置 developer_token，请在「个人设置 → MCC 管理」中编辑该 MCC 填写 Developer Token`);

  try {
    const { updateCampaignStatus } = await import("@/lib/google-ads");
    const newStatus = action === "enable" ? "ENABLED" as const : "PAUSED" as const;
    const result = await updateCampaignStatus(
      { mcc_id: mcc.mcc_id, developer_token: mcc.developer_token, service_account_json: mcc.service_account_json },
      campaign.customer_id || "",
      campaign.google_campaign_id,
      newStatus,
    );

    if (!result.success) return apiError(result.message);
    return apiSuccess({ status: newStatus }, `广告已${action === "enable" ? "启用" : "暂停"}`);
  } catch (err) {
    return apiError(`操作失败: ${err instanceof Error ? err.message : String(err)}`);
  }
}
