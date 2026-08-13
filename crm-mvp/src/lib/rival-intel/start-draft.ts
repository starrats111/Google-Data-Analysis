/**
 * 领取商家 / 新增广告时自动起一份竞品情报草稿。
 *
 * 07 的要求是「员工不用手填任何东西」：kyads 那边第一步是让人手贴域名、贴联盟链接、
 * 点验证；CRM 这边商家行里本来就有 merchant_url 和该账号的追踪链接，所以域名和落地页
 * 都从商家带入，草稿建完直接进后台生成，员工打开向导时看到的已经是「生成中」。
 *
 * 缓存优先：同 (域名, 国家, 语言, 模式) 24h 内公司里已经跑出过成品，就克隆一份，
 * 不再花第二次 SerpApi + LLM 的钱。
 */
import prisma from "@/lib/prisma";
import { createDraft } from "./ad-create/repository";
import { createDraftFromCache, findReusableReadyDraft } from "./ad-create/draft-cache";
import { deriveRootDomainFromFinalUrl } from "./ad-create/final-url";
import { enqueueDraftGeneration } from "./draft-generation-runner";
import type { AdGenerationMode } from "./deps/generation-mode";

/**
 * CRM 没有「生成模式」这个开关，kyads 的 filter 模式只从竞品现成文案里挑，产出常常
 * 凑不满 RSA 的 3 标题 2 描述（它自己的 gap_report 就是为这个准备的）。默认走
 * ai_generate：把竞品创意当样本让 AI 重写，产出稳定，也是 kyads 生产实际在用的模式。
 */
const DEFAULT_GENERATION_MODE: AdGenerationMode = "ai_generate";

export interface StartRivalIntelDraftResult {
  draftId: bigint;
  domain: string;
  /** true = 命中公司缓存，直接就是 draft_ready */
  fromCache: boolean;
}

/**
 * 从商家行推导要评估的域名。
 *
 * 用商家自己的站点域名（nvidia.com），不是联盟追踪域名（go.linkby.com 之类）——
 * 品牌评估要查的是「这个品牌的词有谁在竞价」，拿追踪域名去查什么也查不到。
 */
export function resolveMerchantDomain(merchant: {
  merchant_url?: string | null;
  campaign_link?: string | null;
  tracking_link?: string | null;
}): string | null {
  const direct = deriveRootDomainFromFinalUrl(merchant.merchant_url || "");
  if (direct) return direct;

  // merchant_url 为空时退回追踪链接里内嵌的目标地址（?url= / ?new= 是常见的联盟写法）
  for (const raw of [merchant.campaign_link, merchant.tracking_link]) {
    const link = (raw || "").trim();
    if (!link) continue;
    try {
      const parsed = new URL(link);
      const inner = parsed.searchParams.get("url") || parsed.searchParams.get("new");
      const fromInner = inner ? deriveRootDomainFromFinalUrl(decodeURIComponent(inner)) : null;
      if (fromInner) return fromInner;
    } catch {
      // 不是合法 URL，跳过
    }
  }
  return null;
}

export async function startRivalIntelDraft(input: {
  userId: bigint;
  userMerchantId: bigint;
  campaignId: bigint;
  countryCode: string;
  /** 员工在领取弹窗选的广告语言；null = 跟随国家推导 */
  languageCode?: string | null;
  merchant: {
    merchant_url?: string | null;
    campaign_link?: string | null;
    tracking_link?: string | null;
  };
  /** 广告落地页（CRM 领取时算出的联盟追踪链接） */
  landingPageUrl?: string | null;
}): Promise<StartRivalIntelDraftResult | null> {
  const domain = resolveMerchantDomain(input.merchant);
  if (!domain) {
    console.warn(
      `[RivalIntel] merchant=${input.userMerchantId} 取不到商家域名，竞品情报草稿未创建`,
    );
    return null;
  }

  const countryCode = (input.countryCode || "").trim().toUpperCase();
  const languageCode = input.languageCode?.trim() || null;

  const cached = await findReusableReadyDraft({
    domain,
    countryCode,
    languageCode,
    generationMode: DEFAULT_GENERATION_MODE,
  }).catch(() => null);

  if (cached) {
    const draft = await createDraftFromCache({
      userId: input.userId,
      userMerchantId: input.userMerchantId,
      campaignId: input.campaignId,
      domain,
      countryCode,
      languageCode,
      source: cached,
      landingPageUrl: input.landingPageUrl ?? null,
    });
    console.warn(
      `[RivalIntel] draft=${draft.id} 命中公司缓存（源 draft=${cached.id}），domain=${domain} ${countryCode}`,
    );
    return { draftId: draft.id, domain, fromCache: true };
  }

  const draft = await createDraft({
    userId: input.userId,
    userMerchantId: input.userMerchantId,
    campaignId: input.campaignId,
    domain,
    countryCode,
    languageCode,
    generationMode: DEFAULT_GENERATION_MODE,
    landingPageUrl: input.landingPageUrl ?? null,
  });

  enqueueDraftGeneration(draft.id);
  console.warn(`[RivalIntel] draft=${draft.id} 已入队生成，domain=${domain} ${countryCode}`);
  return { draftId: draft.id, domain, fromCache: false };
}

/** 读员工当前生效的上广告引擎（「我的商家」页顶部卡片选的那个）。 */
export async function readEffectiveAdEngine(userId: bigint): Promise<string> {
  const settings = await prisma.ad_default_settings.findFirst({
    where: { user_id: userId, is_deleted: 0 },
    select: { ad_engine: true },
  });
  return settings?.ad_engine || "evidence";
}
