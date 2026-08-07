import { NextRequest } from "next/server";
import { getUserFromRequest, serializeData } from "@/lib/auth";
import { apiSuccess, apiError } from "@/lib/constants";
import prisma from "@/lib/prisma";
import { resolveAffiliateLink } from "@/lib/affiliate-link-resolver";
import { getMerchantCampaignCountries, pickCruiseCountry } from "@/lib/suffix-engine/merchant-country";

/**
 * POST /api/user/merchants/:id/cruise
 * 手动「测试巡航」：按投放国代理跟随该商家联盟追踪链接，识别上级联盟 + 黑名单 + 追踪参数。
 * 启用无头 Chrome（过 FlexOffers/Impact 指纹门），结果落库。
 * body: { country?: string }（不传则按 商家 target_country → 在投系列投放国 → US 逐级兜底）
 */
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const user = await getUserFromRequest(req);
  if (!user) return apiError("未授权", 401);

  const { id } = await params;
  if (!id) return apiError("缺少商家 ID");

  let body: { country?: string } = {};
  try {
    body = await req.json();
  } catch {
    /* 允许空 body */
  }

  const merchant = await prisma.user_merchants.findFirst({
    where: { id: BigInt(id), user_id: BigInt(user.userId), is_deleted: 0 },
    select: {
      id: true, merchant_name: true, merchant_url: true, platform: true, platform_connection_id: true,
      target_country: true, tracking_link: true, campaign_link: true, connection_campaign_links: true,
    },
  });
  if (!merchant) return apiError("商家不存在", 404);

  // 取联盟追踪链接（账号级优先）
  let affiliateUrl = "";
  const connLinks = (merchant.connection_campaign_links || null) as Record<string, string> | null;
  if (connLinks && merchant.platform_connection_id) {
    affiliateUrl = String(connLinks[String(merchant.platform_connection_id)] || "").trim();
  }
  if (!affiliateUrl) affiliateUrl = String(merchant.campaign_link || "").trim();
  if (!affiliateUrl) affiliateUrl = String(merchant.tracking_link || "").trim();

  if (!affiliateUrl || !/^https?:\/\//i.test(affiliateUrl)) {
    return apiError("该商家没有可用的联盟追踪链接（campaign_link / tracking_link 均为空）");
  }

  const country = body.country
    ? body.country.toUpperCase()
    : pickCruiseCountry(
        merchant.target_country,
        (await getMerchantCampaignCountries([merchant.id])).get(String(merchant.id)),
      );

  const cruise = await resolveAffiliateLink(affiliateUrl, country, merchant.platform || null, {
    useBrowser: true,
    targetDomain: merchant.merchant_url,
  });

  await prisma.user_merchants.update({
    where: { id: merchant.id },
    data: {
      parent_network: cruise.parentNetwork,
      parent_blacklisted: cruise.status === "forbidden_network" ? 1 : 0,
      tracking_status: cruise.status,
      resolved_final_url: cruise.finalUrl?.slice(0, 1024) || null,
      resolve_chain: cruise.chain.slice(0, 20) as unknown as object,
      parent_checked_at: new Date(),
      parent_check_reason: (cruise.error || (cruise.status === "ok" ? "巡航通过" : cruise.status)).slice(0, 255),
    },
  });

  return apiSuccess(
    serializeData({
      affiliateUrl,
      country,
      status: cruise.status,
      parentNetwork: cruise.parentNetwork,
      blacklisted: cruise.status === "forbidden_network",
      landingUrl: cruise.landingUrl,
      trackingLink: cruise.trackingLink,
      finalUrl: cruise.finalUrl,
      chain: cruise.chain,
      usedProxy: cruise.usedProxy,
      usedBrowser: cruise.usedBrowser,
      error: cruise.error || null,
    }),
  );
}
