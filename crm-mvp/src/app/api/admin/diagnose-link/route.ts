import { NextRequest } from "next/server";
import { getUserFromRequest, serializeData } from "@/lib/auth";
import { apiSuccess, apiError } from "@/lib/constants";
import prisma from "@/lib/prisma";
import { parseCampaignNameFull } from "@/lib/campaign-merchant-link";
import { normalizePlatformCode } from "@/lib/constants";

/**
 * GET /api/admin/diagnose-link?username=wj07
 * 诊断广告系列与商家的关联状态
 */
export async function GET(req: NextRequest) {
  const caller = getUserFromRequest(req);
  if (!caller) return apiError("未授权", 401);

  const { searchParams } = new URL(req.url);
  const username = searchParams.get("username") || caller.username;

  const user = await prisma.users.findFirst({
    where: { username, is_deleted: 0 },
    select: { id: true, username: true },
  });
  if (!user) return apiError("用户不存在");

  const userId = user.id;

  const campaigns = await prisma.campaigns.findMany({
    where: { user_id: userId, is_deleted: 0, google_campaign_id: { not: null } },
    select: {
      id: true, campaign_name: true, google_status: true,
      user_merchant_id: true, google_campaign_id: true, customer_id: true,
    },
    orderBy: { id: "desc" },
  });

  const merchants = await prisma.user_merchants.findMany({
    where: { user_id: userId, is_deleted: 0 },
    select: { id: true, platform: true, merchant_id: true, merchant_name: true, status: true },
  });

  const merchantIndex = new Map(
    merchants.map((m) => [
      `${normalizePlatformCode(m.platform)}_${m.merchant_id}`,
      m,
    ])
  );
  const merchantById = new Map(merchants.map((m) => [String(m.id), m]));

  const unlinked: any[] = [];
  const linked: any[] = [];
  const mismatch: any[] = [];

  for (const c of campaigns) {
    const parsed = parseCampaignNameFull(c.campaign_name || "");
    const isLinked = c.user_merchant_id && c.user_merchant_id !== BigInt(0);

    if (!isLinked) {
      const matchKey = parsed ? `${parsed.platform}_${parsed.mid}` : null;
      const matchMerchant = matchKey ? merchantIndex.get(matchKey) : null;
      unlinked.push({
        campaign_id: c.id,
        campaign_name: c.campaign_name,
        google_status: c.google_status,
        parsed_platform: parsed?.platform || null,
        parsed_mid: parsed?.mid || null,
        match_key: matchKey,
        merchant_found: !!matchMerchant,
        merchant_if_found: matchMerchant ? {
          id: matchMerchant.id,
          name: matchMerchant.merchant_name,
          status: matchMerchant.status,
        } : null,
        parse_failed: !parsed,
      });
    } else {
      const linkedMerchant = merchantById.get(String(c.user_merchant_id));
      const entry: any = {
        campaign_id: c.id,
        campaign_name: c.campaign_name,
        google_status: c.google_status,
        user_merchant_id: c.user_merchant_id,
        merchant_exists: !!linkedMerchant,
        merchant_name: linkedMerchant?.merchant_name || null,
        merchant_status: linkedMerchant?.status || null,
        merchant_platform: linkedMerchant?.platform || null,
        merchant_mid: linkedMerchant?.merchant_id || null,
      };

      if (c.google_status === "ENABLED" && linkedMerchant?.status !== "claimed") {
        mismatch.push(entry);
      }
      linked.push(entry);
    }
  }

  const merchantsWithoutCampaigns = merchants.filter((m) => {
    return (m.status === "claimed" || m.status === "paused") &&
      !campaigns.some((c) => c.user_merchant_id === m.id);
  });

  return apiSuccess(serializeData({
    username: user.username,
    summary: {
      total_campaigns: campaigns.length,
      linked_campaigns: linked.length,
      unlinked_campaigns: unlinked.length,
      enabled_campaigns: campaigns.filter((c) => c.google_status === "ENABLED").length,
      status_mismatch: mismatch.length,
      total_merchants: merchants.length,
      claimed_merchants: merchants.filter((m) => m.status === "claimed").length,
      paused_merchants: merchants.filter((m) => m.status === "paused").length,
      orphan_merchants: merchantsWithoutCampaigns.length,
    },
    status_mismatch: mismatch,
    unlinked_campaigns: unlinked,
    linked_campaigns: linked,
    merchants_without_campaigns: merchantsWithoutCampaigns.map((m) => ({
      id: m.id, platform: m.platform, merchant_id: m.merchant_id,
      merchant_name: m.merchant_name, status: m.status,
    })),
  }));
}
