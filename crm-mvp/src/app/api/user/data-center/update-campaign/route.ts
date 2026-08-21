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
  // D-248：被中止 CID 旗下广告禁止一切操作（前端灰化 + 服务端拦截双层）
  {
    const { getCidSuspendedError } = await import("@/lib/google-ads/cid-suspension");
    const suspendedMsg = await getCidSuspendedError(campaign.customer_id, campaign.mcc_id);
    if (suspendedMsg) return apiError(suspendedMsg, 403);
  }

  const mcc = await prisma.google_mcc_accounts.findFirst({
    where: { id: campaign.mcc_id, user_id: userId, is_deleted: 0 },
  });
  if (!mcc) return apiError("广告系列关联的 MCC 账户不存在", 404);
  {
    const { poolHasCredentialFor } = await import("@/lib/google-ads/token-pool");
    if (!mcc.service_account_json && !(await poolHasCredentialFor(mcc.mcc_id))) {
      return apiError("MCC 未配置服务账号凭证，且组 Token 池中无配对的 Service Account JSON（请组长在「团队设置 → Token 池」配置）", 400);
    }
  }

  try {
    const { updateCampaignBudget, updateCampaignMaxCpc } = await import("@/lib/google-ads");
    const credentials = { mcc_id: mcc.mcc_id, developer_token: mcc.developer_token || "", service_account_json: mcc.service_account_json || "" };

    // D-266 批一：前端输入是美元意图值，按当日汇率换算成账户币种再下发/入库。
    // 汇率不可用时直接拒绝——严禁把美元数字当账户币种发出去（D-265① 病根）。
    const { usdToAccountCurrency } = await import("@/lib/exchange-rate");
    const { todayCST } = await import("@/lib/date-utils");
    const currency = (mcc.currency || "USD").toUpperCase();
    const conv = await usdToAccountCurrency(currency, value, todayCST());
    if (!conv) return apiError(`${currency} 汇率不可用，为避免金额语义错误已中止修改，请稍后重试`, 503);
    const accountValue = Number(conv.value.toFixed(field === "budget" ? 2 : 4));
    const convNote = currency === "USD" ? "" : `（$${value} × 汇率 → ${accountValue} ${currency}）`;

    let result: { success: boolean; message: string };

    if (field === "budget") {
      result = await updateCampaignBudget(credentials, campaign.customer_id || "", campaign.google_campaign_id, accountValue);
      if (result.success) {
        await prisma.campaigns.update({ where: { id: campaign.id }, data: { daily_budget: accountValue } });
      }
    } else {
      result = await updateCampaignMaxCpc(credentials, campaign.customer_id || "", campaign.google_campaign_id, accountValue);
      if (result.success) {
        await prisma.campaigns.update({ where: { id: campaign.id }, data: { max_cpc_limit: accountValue } });
      }
    }

    if (!result.success) return apiError(result.message, 500);

    const updated = await prisma.campaigns.findUnique({ where: { id: campaign.id } });
    return apiSuccess(serializeData({ campaign: updated, message: `${field === "budget" ? "预算" : "最高出价"}已更新为 $${value}${convNote}` }));
  } catch (err) {
    return apiError(`修改失败: ${err instanceof Error ? err.message : String(err)}`, 500);
  }
}
