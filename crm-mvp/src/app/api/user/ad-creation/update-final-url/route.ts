import { NextRequest } from "next/server";
import { getUserFromRequest } from "@/lib/auth";
import { apiSuccess, apiError } from "@/lib/constants";
import prisma from "@/lib/prisma";

/**
 * PATCH /api/user/ad-creation/update-final-url
 * 更新广告素材的落地页 URL（final_url），同时可更新商家的 tracking_link / campaign_link，
 * 以及广告系列的广告语言（language_id）
 *
 * Body:
 *   campaign_id     - 广告系列 ID（必填）
 *   final_url       - 广告落地页 URL（与 language_id 至少填一个）
 *   affiliate_url   - 联盟跟踪链接（选填，保存到 user_merchants.tracking_link + campaign_link）
 *   language_id     - 广告语言 code（选填，如 "nl", "fr"，由爬虫自动检测或用户手动设置）
 */
export async function PATCH(req: NextRequest) {
  const user = getUserFromRequest(req);
  if (!user) return apiError("未授权", 401);

  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return apiError("请求体解析失败", 400);
  }

  const { campaign_id, final_url, affiliate_url, language_id, final_url_suffix } = body as {
    campaign_id?: string;
    final_url?: string;
    affiliate_url?: string;
    language_id?: string;
    final_url_suffix?: string;
  };

  if (!campaign_id) return apiError("缺少 campaign_id");

  const hasUrl = final_url && String(final_url).trim();
  const hasLang = language_id && String(language_id).trim();
  const hasSuffix = final_url_suffix !== undefined;
  if (!hasUrl && !hasLang && !hasSuffix) return apiError("final_url、language_id、final_url_suffix 至少填一个");

  let fixedUrl = hasUrl ? (final_url as string).trim() : "";
  if (fixedUrl) {
    if (!fixedUrl.startsWith("http")) return apiError("落地页 URL 必须以 http:// 或 https:// 开头");
    if (fixedUrl.startsWith("http://")) fixedUrl = fixedUrl.replace("http://", "https://");
  }

  const userId = BigInt(user.userId);

  // 验证 campaign 归属
  const campaign = await prisma.campaigns.findFirst({
    where: { id: BigInt(campaign_id), user_id: userId, is_deleted: 0 },
    select: { id: true, user_merchant_id: true },
  });
  if (!campaign) return apiError("广告系列不存在", 404);

  // 查找广告组和广告素材
  const adGroup = await prisma.ad_groups.findFirst({
    where: { campaign_id: campaign.id, is_deleted: 0 },
    select: { id: true },
  });
  if (!adGroup) return apiError("广告系列正在初始化，请稍等 1 分钟后刷新页面再试");

  const adCreative = await prisma.ad_creatives.findFirst({
    where: { ad_group_id: adGroup.id, is_deleted: 0 },
    select: { id: true },
  });
  if (!adCreative) return apiError("广告素材不存在");

  const updates: Promise<unknown>[] = [];

  // 更新 final_url
  if (fixedUrl) {
    updates.push(prisma.ad_creatives.update({
      where: { id: adCreative.id },
      data: { final_url: fixedUrl },
    }));
  }

  // 更新广告语言（保存到 campaigns.language_id）
  if (language_id && typeof language_id === "string") {
    updates.push(prisma.campaigns.update({
      where: { id: campaign.id },
      data: { language_id: language_id.trim() },
    }));
  }

  // 更新最终到达网址后缀（保存到 campaigns.final_url_suffix）
  if (hasSuffix) {
    const suffixVal = typeof final_url_suffix === "string" ? final_url_suffix.trim() : null;
    updates.push(prisma.campaigns.update({
      where: { id: campaign.id },
      data: { final_url_suffix: suffixVal || null } as any,
    }));
  }

  // 若提供了联盟跟踪链接，同步更新商家记录
  if (affiliate_url && typeof affiliate_url === "string" && affiliate_url.startsWith("http")) {
    updates.push(prisma.user_merchants.update({
      where: { id: campaign.user_merchant_id },
      data: {
        tracking_link: affiliate_url,
        campaign_link: affiliate_url,
      },
    }));
  }

  await Promise.all(updates);

  return apiSuccess({ message: "已更新" });
}
