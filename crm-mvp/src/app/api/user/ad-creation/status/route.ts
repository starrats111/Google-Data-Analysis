import { NextRequest } from "next/server";
import { getUserFromRequest, serializeData } from "@/lib/auth";
import { apiSuccess, apiError } from "@/lib/constants";
import prisma from "@/lib/prisma";

// 防止并发重复触发 AI 生成
const generatingSet = new Set<string>();

/**
 * GET /api/user/ad-creation/status?campaign_id=xxx
 * 获取广告创建状态（含 headlines/descriptions/keywords/设置）
 * 用于广告预览页轮询加载
 * 如果 headlines 为空且超过 10 秒，自动重新触发 AI 生成
 */
export async function GET(req: NextRequest) {
  const user = getUserFromRequest(req);
  if (!user) return apiError("未授权", 401);

  const { searchParams } = new URL(req.url);
  const campaignId = searchParams.get("campaign_id");
  if (!campaignId) return apiError("缺少 campaign_id");

  const campaign = await prisma.campaigns.findFirst({
    where: { id: BigInt(campaignId), user_id: BigInt(user.userId), is_deleted: 0 },
  });
  if (!campaign) return apiError("广告系列不存在", 404);

  // 获取广告组
  const adGroup = await prisma.ad_groups.findFirst({
    where: { campaign_id: campaign.id, is_deleted: 0 },
  });

  // 获取广告素材
  let adCreative = null;
  if (adGroup) {
    adCreative = await prisma.ad_creatives.findFirst({
      where: { ad_group_id: adGroup.id, is_deleted: 0 },
    });
  }

  // 获取关键词
  let keywords: { id: bigint; keyword_text: string; match_type: string }[] = [];
  if (adGroup) {
    keywords = await prisma.keywords.findMany({
      where: { ad_group_id: adGroup.id, is_deleted: 0 },
      select: { id: true, keyword_text: true, match_type: true },
    });
  }

  // 获取用户默认广告设置
  const adSettings = await prisma.ad_default_settings.findFirst({
    where: { user_id: BigInt(user.userId), is_deleted: 0 },
  });

  // 获取商家信息
  const merchant = await prisma.user_merchants.findFirst({
    where: { id: campaign.user_merchant_id, is_deleted: 0 },
    select: { merchant_name: true, merchant_url: true, platform: true, merchant_id: true, tracking_link: true },
  });

  // 获取用户的 MCC 账户列表
  const mccAccounts = await prisma.google_mcc_accounts.findMany({
    where: { user_id: BigInt(user.userId), is_deleted: 0, is_active: 1 },
    select: { id: true, mcc_id: true, mcc_name: true, currency: true },
    orderBy: { created_at: "asc" },
  });

  // 判断是否就绪（headlines 和 descriptions 已填充）
  const headlines = (adCreative?.headlines as string[]) || [];
  const descriptions = (adCreative?.descriptions as string[]) || [];
  const isReady = headlines.length >= 1 && descriptions.length >= 1;

  // 如果未就绪且创建超过 10 秒，自动重新触发 AI 生成（防止领取时异步任务丢失）
  if (!isReady && adCreative && adGroup && merchant) {
    const ageMs = Date.now() - new Date(adCreative.created_at).getTime();
    const genKey = `adcopy-${adCreative.id}`;
    if (ageMs > 10000 && !generatingSet.has(genKey)) {
      generatingSet.add(genKey);
      console.log(`[AdCopy] 检测到 headlines 为空（已过 ${Math.round(ageMs / 1000)}s），重新触发 AI 生成...`);
      triggerAdCopyGeneration(
        adCreative.id,
        adGroup.id,
        merchant.merchant_name,
        merchant.merchant_url || "",
        campaign.target_country || "US",
      ).catch((err) => console.error("[AdCopy] 重新触发失败:", err))
        .finally(() => generatingSet.delete(genKey));
    }
  }

  const zhH = ((adCreative as any)?.headlines_zh as string[]) || [];
  const zhD = ((adCreative as any)?.descriptions_zh as string[]) || [];

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
    } : null,
    keywords,
    adSettings: adSettings ? {
      bidding_strategy: adSettings.bidding_strategy,
      max_cpc: adSettings.max_cpc,
      daily_budget: adSettings.daily_budget,
      network_search: adSettings.network_search,
      network_partners: adSettings.network_partners,
      network_display: adSettings.network_display,
      eu_political_ad: adSettings.eu_political_ad,
    } : null,
    merchant,
    mccAccounts,
    isReady,
  }));
}

/**
 * 异步触发广告文案生成（SemRush 竞品数据 + AI 补充）
 */
async function triggerAdCopyGeneration(
  adCreativeId: bigint,
  adGroupId: bigint,
  merchantName: string,
  merchantUrl: string,
  country: string,
) {
  try {
    const { SemRushClient } = await import("@/lib/semrush-client");
    const { padHeadlines, padDescriptions } = await import("@/lib/ai-service");

    let dedupedTitles: string[] = [];
    let dedupedDescriptions: string[] = [];
    let kws: { phrase: string; volume: number }[] = [];

    if (merchantUrl) {
      try {
        const client = await SemRushClient.fromConfig(country);
        const result = await client.queryDomain(merchantUrl);
        dedupedTitles = result.dedupedTitles;
        dedupedDescriptions = result.dedupedDescriptions;
        kws = result.keywords;
        console.log(`[AdCopy] SemRush 成功: ${dedupedTitles.length} 标题, ${dedupedDescriptions.length} 描述, ${kws.length} 关键词`);
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err);
        console.warn("[AdCopy] SemRush 失败，将完全由 AI 生成:", errMsg);
      }
    }

    const headlines = await padHeadlines(dedupedTitles, merchantName, country, 15);
    const descriptions = await padDescriptions(dedupedDescriptions, merchantName, country, 4);

    // 自动翻译为中文参考
    let headlinesZh: string[] = [];
    let descriptionsZh: string[] = [];
    try {
      const { callAiWithFallback } = await import("@/lib/ai-service");
      const zhPrompt = `Translate these Google Ads headlines and descriptions into Simplified Chinese (中文).
This is for reference only, no character limit. Translate naturally.

HEADLINES:
${headlines.map((h: string, i: number) => `${i + 1}. "${h}"`).join("\n")}

DESCRIPTIONS:
${descriptions.map((d: string, i: number) => `${i + 1}. "${d}"`).join("\n")}

Return ONLY JSON: {"headlines":["中文标题1","..."],"descriptions":["中文描述1","..."]}`;
      const zhRaw = await callAiWithFallback("translate", [{ role: "user", content: zhPrompt }], 4096);
      let zhText = zhRaw.trim();
      const js = zhText.indexOf("{");
      const je = zhText.lastIndexOf("}");
      if (js >= 0 && je > js) zhText = zhText.slice(js, je + 1);
      const zhParsed = JSON.parse(zhText);
      headlinesZh = (zhParsed.headlines || []).map((s: string) => s.trim());
      descriptionsZh = (zhParsed.descriptions || []).map((s: string) => s.trim());
      console.log(`[AdCopy] 中文翻译完成: ${headlinesZh.length} 标题, ${descriptionsZh.length} 描述`);
    } catch (zhErr) {
      console.warn("[AdCopy] 中文翻译失败（不影响主流程）:", zhErr instanceof Error ? zhErr.message : zhErr);
    }

    await prisma.ad_creatives.update({
      where: { id: adCreativeId },
      data: {
        headlines: headlines as any,
        descriptions: descriptions as any,
        ...(headlinesZh.length > 0 ? { headlines_zh: headlinesZh as any } : {}),
        ...(descriptionsZh.length > 0 ? { descriptions_zh: descriptionsZh as any } : {}),
      },
    });

    if (kws.length > 0) {
      // 先检查是否已有关键词，避免重复插入
      const existingCount = await prisma.keywords.count({
        where: { ad_group_id: adGroupId, is_deleted: 0 },
      });
      if (existingCount === 0) {
        await prisma.keywords.createMany({
          data: kws.map((kw) => ({
            ad_group_id: adGroupId,
            keyword_text: kw.phrase,
            match_type: "PHRASE",
          })),
        });
      }
    }

    console.log(`[AdCopy] 完成: ${headlines.length} 标题, ${descriptions.length} 描述, ${kws.length} 关键词`);
  } catch (err) {
    console.error("[AdCopy] 广告文案生成异常:", err instanceof Error ? err.message : err);
  }
}
