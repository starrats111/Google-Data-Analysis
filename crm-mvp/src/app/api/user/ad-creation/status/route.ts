import { NextRequest } from "next/server";
import { getUserFromRequest, serializeData } from "@/lib/auth";
import { apiSuccess, apiError } from "@/lib/constants";
import prisma from "@/lib/prisma";
import { mapStoredKeywordsForClient } from "@/lib/ad-keyword-pipeline";

// 防止频繁触发 AI 生成：key → { lastTs: 上次触发时间, count: 累计触发次数 }
// 无论成功或失败都保持冷却期，超过最大次数后彻底停止自动触发
const genCooldown = new Map<string, { lastTs: number; count: number }>();
const GEN_COOLDOWN_MS = 10 * 60 * 1000; // 10 分钟冷却
const GEN_MAX_AUTO_RETRIES = 3; // 单个 adCreative 最多自动触发 3 次

/**
 * GET /api/user/ad-creation/status?campaign_id=xxx
 * 获取广告创建状态（含 headlines/descriptions/keywords/设置）
 * 用于广告预览页轮询加载
 * 如果文案未就绪且超过 45 秒，自动重新触发 AI 生成（仅补充缺失部分）
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

  // 判断是否就绪（标题必须满 15 条，描述必须满 4 条）
  const headlines = (adCreative?.headlines as string[]) || [];
  const descriptions = (adCreative?.descriptions as string[]) || [];
  const isReady = headlines.length >= 15 && descriptions.length >= 4;

  // 如果未就绪且创建超过 45 秒，自动重新触发 AI 补充（仅生成缺失部分）
  // 三重保护：冷却期 + 最大次数上限 + 成功/失败都不立即清除冷却
  console.log(`[AdCopy:status] isReady=${isReady}, adCreative=${!!adCreative}, adGroup=${!!adGroup}, merchant=${!!merchant}, h=${headlines.length}/15 d=${descriptions.length}/4`);
  if (!isReady && adCreative && adGroup && merchant) {
    const ageMs = Date.now() - new Date(adCreative.created_at).getTime();
    const genKey = `adcopy-${adCreative.id}`;
    const state = genCooldown.get(genKey);
    const lastTry = state?.lastTs || 0;
    const tryCount = state?.count || 0;
    console.log(`[AdCopy:check] key=${genKey} age=${Math.round(ageMs/1000)}s tryCount=${tryCount}/${GEN_MAX_AUTO_RETRIES} cooldownLeft=${Math.max(0, GEN_COOLDOWN_MS - (Date.now() - lastTry))}ms`);

    if (tryCount >= GEN_MAX_AUTO_RETRIES) {
      console.log(`[AdCopy:skip] 已达上限 ${tryCount}/${GEN_MAX_AUTO_RETRIES}`);
    } else if (ageMs > 45000 && Date.now() - lastTry > GEN_COOLDOWN_MS) {
      const newCount = tryCount + 1;
      genCooldown.set(genKey, { lastTs: Date.now(), count: newCount });
      console.log(`[AdCopy] 补充生成 (${newCount}/${GEN_MAX_AUTO_RETRIES})：标题${headlines.length}/15 描述${descriptions.length}/4，已过 ${Math.round(ageMs / 1000)}s`);
      triggerAdCopyGeneration(
        adCreative.id,
        adGroup.id,
        merchant.merchant_name,
        merchant.merchant_url || "",
        campaign.target_country || "US",
        {
          existingHeadlines: headlines,
          existingDescriptions: descriptions,
          dailyBudget: Number(campaign.daily_budget || adSettings?.daily_budget || 1.5),
          maxCpc: Number(campaign.max_cpc_limit || adSettings?.max_cpc || 0.3),
          biddingStrategy: campaign.bidding_strategy || adSettings?.bidding_strategy || "MAXIMIZE_CLICKS",
          aiRuleProfile: (adSettings as any)?.ai_rule_profile,
        },
      ).catch((err) => console.error(`[AdCopy] 补充生成失败 (${newCount}/${GEN_MAX_AUTO_RETRIES}，冷却 ${GEN_COOLDOWN_MS / 60000} 分钟):`, err));
    }
  }

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

/**
 * 补充生成广告文案（重试时复用已有数据，仅补充缺失部分）
 * 跳过 SemRush 请求，避免频繁调用导致账号封禁
 */
async function triggerAdCopyGeneration(
  adCreativeId: bigint,
  adGroupId: bigint,
  merchantName: string,
  merchantUrl: string,
  country: string,
  options: {
    existingHeadlines?: string[];
    existingDescriptions?: string[];
    dailyBudget?: number;
    maxCpc?: number;
    biddingStrategy?: string;
    aiRuleProfile?: unknown;
  } = {},
) {
  try {
    const { padHeadlines, padDescriptions, suggestDisplayPaths } = await import("@/lib/ai-service");

    const existH = options.existingHeadlines || [];
    const existD = options.existingDescriptions || [];
    const needHeadlines = existH.length < 15;
    const needDescriptions = existD.length < 4;

    if (!needHeadlines && !needDescriptions) {
      console.log("[AdCopy] 补充检查：标题和描述均已就绪，跳过");
      return;
    }
    console.log(`[AdCopy] 补充模式：标题 ${existH.length}/15, 描述 ${existD.length}/4`);

    const commonOpts = {
      keywords: [] as string[],
      dailyBudget: options.dailyBudget,
      maxCpc: options.maxCpc,
      biddingStrategy: options.biddingStrategy,
      aiRuleProfile: options.aiRuleProfile,
    };

    const tasks: Promise<void>[] = [];

    if (needHeadlines) {
      tasks.push(
        padHeadlines(existH, merchantName, country, 15, commonOpts).then(async (headlines) => {
          const existingCreative = await prisma.ad_creatives.findUnique({
            where: { id: adCreativeId },
            select: { display_path1: true, display_path2: true },
          });
          const pathSuggest = suggestDisplayPaths(merchantName, [], country);
          await prisma.ad_creatives.update({
            where: { id: adCreativeId },
            data: {
              headlines: headlines as any,
              ...(!existingCreative?.display_path1?.trim() ? { display_path1: pathSuggest.path1 } : {}),
              ...(!existingCreative?.display_path2?.trim() ? { display_path2: pathSuggest.path2 } : {}),
            },
          });
          console.log(`[AdCopy] 标题补充完成 (${headlines.length} 条)`);
        }),
      );
    }

    if (needDescriptions) {
      tasks.push(
        padDescriptions(existD, merchantName, country, 4, commonOpts).then(async (descriptions) => {
          await prisma.ad_creatives.update({
            where: { id: adCreativeId },
            data: { descriptions: descriptions as any },
          });
          console.log(`[AdCopy] 描述补充完成 (${descriptions.length} 条)`);
        }),
      );
    }

    await Promise.all(tasks);
    console.log("[AdCopy] 补充生成全部完成");
  } catch (err) {
    console.error("[AdCopy] 补充生成异常:", err instanceof Error ? err.message : err);
  }
}
