import { NextRequest } from "next/server";
import { getUserFromRequest, serializeData } from "@/lib/auth";
import { apiSuccess, apiError } from "@/lib/constants";
import prisma from "@/lib/prisma";
import { mapStoredKeywordsForClient } from "@/lib/ad-keyword-pipeline";

/**
 * GET /api/user/ad-creation/status?campaign_id=xxx
 * 纯状态查询：返回广告预览所需的全部数据，无任何副作用
 * AI 生成完全由前端通过 generate-extensions 端点主动触发
 */
export async function GET(req: NextRequest) {
  const user = getUserFromRequest(req);
  if (!user) return apiError("未授权", 401);

  const { searchParams } = new URL(req.url);
  const campaignId = searchParams.get("campaign_id");
  if (!campaignId) return apiError("缺少 campaign_id");

  // Phase A: campaign + 只依赖 userId 的查询并行
  const [campaign, adSettings, mccAccounts] = await Promise.all([
    prisma.campaigns.findFirst({
      where: { id: BigInt(campaignId), user_id: BigInt(user.userId), is_deleted: 0 },
    }),
    prisma.ad_default_settings.findFirst({
      where: { user_id: BigInt(user.userId), is_deleted: 0 },
    }),
    prisma.google_mcc_accounts.findMany({
      where: { user_id: BigInt(user.userId), is_deleted: 0, is_active: 1 },
      select: { id: true, mcc_id: true, mcc_name: true, currency: true },
      orderBy: { created_at: "asc" },
    }),
  ]);
  if (!campaign) return apiError("广告系列不存在", 404);

  // Phase B: 依赖 campaign 的查询并行
  const [adGroup, merchant] = await Promise.all([
    prisma.ad_groups.findFirst({
      where: { campaign_id: campaign.id, is_deleted: 0 },
    }),
    prisma.user_merchants.findFirst({
      where: { id: campaign.user_merchant_id, is_deleted: 0 },
      select: { merchant_name: true, merchant_url: true, platform: true, merchant_id: true, tracking_link: true },
    }),
  ]);

  // Phase C: 依赖 adGroup 的查询并行
  let adCreative = null;
  let keywords: {
    id: bigint;
    keyword_text: string;
    match_type: string;
    avg_monthly_searches: number | null;
    competition: string | null;
    suggested_bid: unknown;
  }[] = [];
  if (adGroup) {
    const [creative, kws] = await Promise.all([
      prisma.ad_creatives.findFirst({
        where: { ad_group_id: adGroup.id, is_deleted: 0 },
      }),
      prisma.keywords.findMany({
        where: { ad_group_id: adGroup.id, is_deleted: 0 },
        select: { id: true, keyword_text: true, match_type: true, avg_monthly_searches: true, competition: true, suggested_bid: true },
      }),
    ]);
    adCreative = creative;
    keywords = kws;
  }

  const headlines = (adCreative?.headlines as string[]) || [];
  const descriptions = (adCreative?.descriptions as string[]) || [];
  const isReady = headlines.length >= 15 && descriptions.length >= 4;

  const zhH = ((adCreative as any)?.headlines_zh as string[]) || [];
  const zhD = ((adCreative as any)?.descriptions_zh as string[]) || [];
  const keywordView = mapStoredKeywordsForClient(keywords, {
    merchantName: merchant?.merchant_name || "",
    dailyBudget: Number(campaign.daily_budget || adSettings?.daily_budget || 1.5),
    maxCpc: Number(campaign.max_cpc_limit || adSettings?.max_cpc || 0.3),
    biddingStrategy: campaign.bidding_strategy || adSettings?.bidding_strategy || "MAXIMIZE_CLICKS",
    aiRuleProfile: (adSettings as any)?.ai_rule_profile,
  });

  return apiSuccess(serializeData({
    campaign: {
      id: campaign.id,
      campaign_name: campaign.campaign_name,
      daily_budget: campaign.daily_budget,
      bidding_strategy: campaign.bidding_strategy,
      max_cpc_limit: campaign.max_cpc_limit,
      target_country: campaign.target_country,
      geo_target: campaign.geo_target,
      network_search: campaign.network_search,
      network_partners: campaign.network_partners,
      network_display: campaign.network_display,
      language_id: campaign.language_id,
      google_campaign_id: campaign.google_campaign_id,
      customer_id: campaign.customer_id,
      mcc_id: campaign.mcc_id,
    },
    adGroup: adGroup ? { id: adGroup.id, ad_group_name: adGroup.ad_group_name, keyword_match_type: adGroup.keyword_match_type } : null,
    adCreative: adCreative ? {
      id: adCreative.id,
      final_url: adCreative.final_url,
      display_path1: adCreative.display_path1,
      display_path2: adCreative.display_path2,
      headlines,
      descriptions,
      headlines_zh: (adCreative as any).headlines_zh || [],
      descriptions_zh: (adCreative as any).descriptions_zh || [],
      sitelinks: adCreative.sitelinks,
      callouts: adCreative.callouts,
      image_urls: adCreative.image_urls,
    } : null,
    keywords: keywordView,
    adSettings: adSettings ? {
      bidding_strategy: adSettings.bidding_strategy,
      max_cpc: adSettings.max_cpc,
      daily_budget: adSettings.daily_budget,
      network_search: adSettings.network_search,
      network_partners: adSettings.network_partners,
      network_display: adSettings.network_display,
      eu_political_ad: (adSettings as any).eu_political_ad ?? 0,
      ai_rule_profile: (adSettings as any).ai_rule_profile ?? null,
    } : null,
    merchant,
    mccAccounts,
    isReady,
  }));
}

