import { NextRequest } from "next/server";
import { getUserFromRequest } from "@/lib/auth";
import { apiSuccess, apiError } from "@/lib/constants";
import prisma from "@/lib/prisma";
import {
  campaignFormalSequenceWhere,
  campaignNameCleanAndMmdd,
  hasAssignedFormalCampaignName,
  resolvePlatformLabel,
} from "@/lib/campaign-naming";

/**
 * GET /api/user/ad-creation/preview-name?campaign_id=N&mcc_account_id=M
 *
 * C-088（2026-05-26）：广告预览页"广告系列名(可修改)"输入框默认值。
 * 返回**预测的正式名**（不占号、不写 DB、不持锁、不进事务），
 * 用户可在输入框任意修改后提交。
 *
 * 规则：
 * - 若 campaign 已有正式名（首段 NNN- 数字 + ≥6 段） → 直接返回当前名（用户已自定义）
 * - 否则：seq = (DB 中该 user 全部 NNN- 开头 live formal camp 的 max) + 1
 *         拼装 `${seq}-${platformLabel}-${cleanName}-${country}-${mmdd}-${merchantId}`
 *
 * 真正占号仍在 submit 路由内通过 GET_LOCK 分布式锁完成，本端点纯展示用。
 */
export async function GET(req: NextRequest) {
  const user = getUserFromRequest(req);
  if (!user) return apiError("未授权", 401);

  const url = new URL(req.url);
  const campaignIdStr = url.searchParams.get("campaign_id");
  const mccAccountIdStr = url.searchParams.get("mcc_account_id");
  if (!campaignIdStr) return apiError("缺少 campaign_id");

  const userId = BigInt(user.userId);
  const campaignId = BigInt(campaignIdStr);

  const campaign = await prisma.campaigns.findFirst({
    where: { id: campaignId, user_id: userId, is_deleted: 0 },
    select: {
      id: true,
      campaign_name: true,
      target_country: true,
      mcc_id: true,
      user_merchant_id: true,
    },
  });
  if (!campaign) return apiError("广告系列不存在", 404);

  if (hasAssignedFormalCampaignName(campaign.campaign_name)) {
    return apiSuccess({
      predictedName: campaign.campaign_name,
      alreadyAssigned: true,
    });
  }

  const merchant = await prisma.user_merchants.findFirst({
    where: { id: campaign.user_merchant_id, is_deleted: 0 },
    select: { merchant_name: true, merchant_id: true, platform: true, platform_connection_id: true },
  });
  if (!merchant) return apiError("商家不存在", 404);

  const mccId = mccAccountIdStr ? BigInt(mccAccountIdStr) : (campaign.mcc_id ?? null);

  const platformLabel = await resolvePlatformLabel(
    userId,
    merchant.platform || "",
    merchant.platform_connection_id,
  );

  const existing = await prisma.campaigns.findMany({
    where: campaignFormalSequenceWhere(userId, mccId) as never,
    select: { campaign_name: true },
  });

  let maxSeq = 0;
  for (const c of existing) {
    const name = c.campaign_name || "";
    const parts = name.split("-");
    if (parts.length < 6) continue;
    if (!/^\d+$/.test(parts[0])) continue;
    const n = parseInt(parts[0], 10);
    if (n > maxSeq) maxSeq = n;
  }
  const seq = maxSeq + 1;

  const { cleanName, mmdd } = campaignNameCleanAndMmdd(merchant.merchant_name || "");
  const seqStr = String(seq).padStart(3, "0");
  const country = (campaign.target_country || "US").toUpperCase();
  const merchantIdStr = merchant.merchant_id || "";
  const predictedName = `${seqStr}-${platformLabel}-${cleanName}-${country}-${mmdd}-${merchantIdStr}`;

  return apiSuccess({
    predictedName,
    alreadyAssigned: false,
    parts: { seq: seqStr, platformLabel, cleanName, country, mmdd, merchantId: merchantIdStr },
  });
}
