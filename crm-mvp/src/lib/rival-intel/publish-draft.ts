/**
 * 竞品情报引擎的发布层：把生成好的草稿交给 CRM 现成的提交流水线。
 *
 * D-233 最大的一处「不照搬」。kyads 有一整套自己的发布器：`google-ads-publisher.ts`
 * 里重写了 mutate、CID 枚举、错误解析、地理/语言映射，外加 publish-runner /
 * publish-guard / publish-input / cid-selector 和一张 `ad_creation_publish_jobs` 表。
 * 那些能力 CRM 全都有，而且更厚：
 *
 *   - Token 池轮询 + 429 退避（kyads 是单 developer token）
 *   - 政策违规自动改写 RSA 后重投（kyads 直接失败）
 *   - `operationNotPermittedForContext` 时自动换 CID 重试
 *   - 同名系列查重与对账（campaign-dedup）
 *   - 图片素材、Callout、Promotion、Price、Call、结构化片段
 *   - 发布成功后 campaigns / ad_groups / keywords / ad_creatives 的事务回写
 *
 * 更要紧的是 07 明确要求两个引擎**统一六段命名、共用一个序号池**。CRM 的序号是
 * `campaign-naming.ts` 用 MySQL `GET_LOCK('campseq_{userId}')` 从 campaigns 表现算的，
 * 没有独立序列表。如果竞品引擎自己发布，就得把那把锁和占号逻辑再实现一遍——两套实现
 * 迟早在 Google Ads 里撞出重名。走同一条 submit 就天然同池，零新增代码。
 *
 * 所以竞品引擎在 CRM 里的定位收敛成「一个生成器」：它产出的标题/描述/品牌词/否词写进
 * CRM 的规范资产表（ad_creatives / keywords），发布 100% 走 evidence 引擎那条 submit。
 * 代价是 kyads 发布阶段的两处引擎特色需要显式保留，见下方 PHRASE 匹配与落地页取值。
 */
import prisma from "@/lib/prisma";
import { createOrReuseSubmitJob, enqueueSubmitJob } from "@/lib/submit-runner";
import { getDraftById } from "./ad-create/repository";
import {
  extractDescriptionTexts,
  extractHeadlineTexts,
  normalizeSitelinks,
} from "./ad-create/normalize-items";

export interface PublishDraftResult {
  campaignId: bigint;
  submitJobId: bigint;
  reused: boolean;
  headlines: number;
  descriptions: number;
  keywords: number;
  negativeKeywords: number;
}

export class PublishDraftError extends Error {
  constructor(message: string, readonly status = 400) {
    super(message);
    this.name = "PublishDraftError";
  }
}

/**
 * 把草稿资产同步到 CRM 规范表，然后建提交 job 投入后台。
 *
 * 命名刻意不传 `campaign_name_custom`：留空时 submit 会调
 * `assignFormalCampaignNameBeforeSubmit`，也就是和 evidence 引擎同一套六段命名 +
 * 同一个序号池。这是「统一命名」需求的落点，不要在这里自己拼名字。
 */
export async function publishDraft(args: {
  draftId: bigint;
  userId: bigint;
  /** 员工在向导第四步选的 CID；留空则由 submit 自己按可用性挑 */
  customerId?: string | null;
}): Promise<PublishDraftResult> {
  const draft = await getDraftById(args.draftId);
  if (!draft || draft.is_deleted === 1) {
    throw new PublishDraftError("草稿不存在", 404);
  }
  if (draft.user_id !== args.userId) {
    throw new PublishDraftError("草稿不属于当前用户", 403);
  }
  if (draft.status !== "draft_ready") {
    throw new PublishDraftError(`草稿尚未生成完成（当前状态 ${draft.status}），无法发布`, 409);
  }
  if (!draft.campaign_id) {
    throw new PublishDraftError("草稿未关联广告系列，无法发布", 409);
  }

  const applied = await applyDraftAssetsToCampaign({
    draftId: args.draftId,
    userId: args.userId,
  });

  const settings = await prisma.ad_default_settings.findFirst({
    where: { user_id: args.userId, is_deleted: 0 },
  });

  const payload = {
    campaign_id: applied.campaignId.toString(),
    headlines: applied.headlines,
    descriptions: applied.descriptions,
    // 品牌词套利是这条引擎的立身之本：品牌词必须 PHRASE，不能被 submit 的默认匹配方式
    // 放宽成 BROAD 去吃泛流量。
    keywords: applied.keywords.map((text) => ({ text, matchType: "PHRASE" })),
    negative_keywords: applied.negativeKeywords,
    sitelinks: applied.sitelinks,
    daily_budget: settings ? Number(settings.daily_budget) : 2,
    max_cpc_limit: settings ? Number(settings.max_cpc) : 0.3,
    bidding_strategy: settings?.bidding_strategy || "MAXIMIZE_CLICKS",
    network_search: (settings?.network_search ?? 1) === 1,
    network_partners: (settings?.network_partners ?? 0) === 1,
    network_display: (settings?.network_display ?? 0) === 1,
    eu_political_ad: settings?.eu_political_ad ?? 0,
    ...(draft.language_code ? { ad_language: draft.language_code } : {}),
    ...(args.customerId ? { customer_id: args.customerId } : {}),
  };

  const job = await createOrReuseSubmitJob({
    campaignId: applied.campaignId,
    userId: args.userId,
    payload,
  });
  enqueueSubmitJob(job.id);

  console.warn(
    `[RivalIntel] draft=${args.draftId} → campaign=${applied.campaignId} 提交入队 job=${job.id} ` +
      `reused=${job.reused} kw=${applied.keywords.length} negKw=${applied.negativeKeywords.length}`,
  );

  return {
    campaignId: applied.campaignId,
    submitJobId: job.id,
    reused: job.reused,
    headlines: applied.headlines.length,
    descriptions: applied.descriptions.length,
    keywords: applied.keywords.length,
    negativeKeywords: applied.negativeKeywords.length,
  };
}

interface AppliedAssets {
  campaignId: bigint;
  headlines: string[];
  descriptions: string[];
  keywords: string[];
  negativeKeywords: string[];
  sitelinks: Array<{
    title: string;
    finalUrl: string;
    description1?: string;
    description2?: string;
  }>;
}

/**
 * 草稿资产 → CRM 规范表（ad_creatives + keywords）。
 *
 * 这一步是「下游功能不残缺」的关键：文案审计、预览页、重发、换链接、结算报表读的都是
 * 这两张表。竞品引擎产出的东西落进来之后，对下游而言它和 evidence 引擎产的广告没有区别，
 * 只有 `keywords.source='rival_intel'` 留了个出处。
 */
export async function applyDraftAssetsToCampaign(args: {
  draftId: bigint;
  userId: bigint;
}): Promise<AppliedAssets> {
  const draft = await getDraftById(args.draftId);
  if (!draft?.campaign_id) {
    throw new PublishDraftError("草稿未关联广告系列", 409);
  }

  const campaign = await prisma.campaigns.findFirst({
    where: { id: draft.campaign_id, user_id: args.userId, is_deleted: 0 },
  });
  if (!campaign) throw new PublishDraftError("广告系列不存在", 404);
  if (campaign.google_campaign_id) {
    throw new PublishDraftError("该广告系列已提交到 Google Ads", 409);
  }

  const adGroup = await prisma.ad_groups.findFirst({
    where: { campaign_id: campaign.id, is_deleted: 0 },
    orderBy: { id: "asc" },
  });
  if (!adGroup) throw new PublishDraftError("广告组不存在（领取商家时应已创建）", 409);

  const headlines = extractHeadlineTexts(draft.headlines);
  const descriptions = extractDescriptionTexts(draft.descriptions);
  if (headlines.length < 3) {
    throw new PublishDraftError(`标题只有 ${headlines.length} 条，Google Ads 要求至少 3 条`, 422);
  }
  if (descriptions.length < 2) {
    throw new PublishDraftError(`描述只有 ${descriptions.length} 条，Google Ads 要求至少 2 条`, 422);
  }

  const sitelinks = normalizeSitelinks(draft.sitelinks).map((s) => ({
    // CRM 的 ad_creatives.sitelinks 用 title，kyads 用 linkText，同一个东西
    title: s.linkText,
    finalUrl: s.finalUrl,
    ...(s.description1 ? { description1: s.description1 } : {}),
    ...(s.description2 ? { description2: s.description2 } : {}),
  }));

  const keywords = (Array.isArray(draft.core_brand_keywords) ? draft.core_brand_keywords : [])
    .filter((kw): kw is string => typeof kw === "string" && kw.trim().length > 0)
    .map((kw) => kw.trim());
  if (keywords.length === 0) {
    throw new PublishDraftError("草稿没有品牌核心词，提交会得到一个无法投放的广告系列", 422);
  }

  const negativeKeywords = (Array.isArray(draft.negative_keywords) ? draft.negative_keywords : [])
    .filter((kw): kw is string => typeof kw === "string" && kw.trim().length > 0)
    .map((kw) => kw.trim());

  const creative = await prisma.ad_creatives.findFirst({
    where: { ad_group_id: adGroup.id, is_deleted: 0 },
    orderBy: { id: "asc" },
  });
  if (!creative) throw new PublishDraftError("广告素材行不存在（领取商家时应已创建）", 409);

  // 落地页优先用 CRM 已有的值：领取商家时写入的是该商家的联盟追踪链接，那才是能结算的
  // 地址。草稿里的 landing_page_url 是 `https://{域名}`，只有 CRM 侧为空时才拿它兜底。
  const existingUrl = (creative.final_url || "").trim();
  const draftUrl = (draft.landing_page_url || "").trim();
  const finalUrl = existingUrl || draftUrl;
  if (!finalUrl.startsWith("http")) {
    throw new PublishDraftError("落地页 URL 无效，请确认商家联盟链接已回填", 422);
  }

  await prisma.$transaction([
    prisma.ad_creatives.update({
      where: { id: creative.id },
      data: {
        headlines: headlines as unknown as object,
        descriptions: descriptions as unknown as object,
        sitelinks: (sitelinks.length > 0 ? sitelinks : null) as unknown as object,
        ...(existingUrl || creative.final_url_locked === 1 ? {} : { final_url: finalUrl }),
      },
    }),
    prisma.keywords.deleteMany({ where: { ad_group_id: adGroup.id } }),
    prisma.keywords.createMany({
      data: keywords.map((text) => ({
        ad_group_id: adGroup.id,
        keyword_text: text.slice(0, 255),
        match_type: "PHRASE",
        source: "rival_intel",
      })),
    }),
  ]);

  return {
    campaignId: campaign.id,
    headlines,
    descriptions,
    keywords,
    negativeKeywords,
    sitelinks,
  };
}
