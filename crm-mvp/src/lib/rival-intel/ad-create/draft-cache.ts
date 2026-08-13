/**
 * 广告生成 — 成品草稿的全公司复用层。
 *
 * 背景：跑完整条链要花 SerpApi 的钱和 LLM 的 token。同一 `(域名, 国家, 语言, 模式)`
 * 公司内已经跑出过成品的，24h 内直接克隆一份给当前员工，不再重跑五个阶段。
 *
 * 做法：按 `(domain, country_code, language_code, generation_mode)` 找最近一条
 * `status = draft_ready` 的草稿，命中即克隆全部已落库字段，新草稿一创建就是
 * `draft_ready`，后台 runner 不会再挑到它。
 *
 * 两点例外：
 *   - `sitelinks` 与 `preview_payload.sitelinks` 一律清空——站内链接要按当前落地页
 *     重新做归因验证，照搬旧的会把别人域名的子页发上去。
 *   - `default_campaign_name` 不复用：那是历史草稿当时算出的序号/MMDD/联盟序号，
 *     照搬过来必然撞号或过期，留空由发布页重新取。
 *   - 只有生成产物共享；发布任务按 user_id 隔离，走 CRM 的 ad_submit_jobs。
 */

import { prisma } from "@/lib/prisma";
import type { Prisma } from "@/generated/prisma/client";
import { DRAFT_STAGES } from "./types";
import {
  isReusableDraftCacheCandidate,
  stripSitelinksFromCachedPreview,
} from "./draft-cache-policy";

/** 默认 24h 命中 TTL，可用 env `AD_CREATE_CACHE_TTL_HOURS` 覆盖。 */
const DEFAULT_TTL_HOURS = 24;

export function getDraftCacheTtlMs(): number {
  const raw = process.env.AD_CREATE_CACHE_TTL_HOURS;
  const parsed = raw ? Number(raw) : NaN;
  const hours = Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_TTL_HOURS;
  return hours * 3600_000;
}

/**
 * 查找最近一条可复用的 `draft_ready` 记录（全公司可见）。
 *
 * - 必须 `status = 'draft_ready'`（五个阶段全跑完）；
 * - 必须 `is_deleted = 0`；
 * - 必须在 TTL 窗口内（竞品在投创意会换，太旧的照抄没有意义）；
 * - 必须关键字段齐全：source_payload / headlines / descriptions / sitelinks / preview_payload。
 *   缺任一字段意味着这份 draft 曾经在某个阶段失败过但被提前标 ready（理论不会发生，兜底）。
 */
export async function findReusableReadyDraft(params: {
  domain: string;
  countryCode: string;
  /** 显式指定的文案语言；null = 跟随国家。不同语言的成品文案不可互换，必须进缓存键。 */
  languageCode?: string | null;
  generationMode: "filter" | "ai_generate";
  now?: Date;
}) {
  const now = params.now ?? new Date();
  const cutoff = new Date(now.getTime() - getDraftCacheTtlMs());

  const candidates = await prisma.ad_creation_drafts.findMany({
    where: {
      domain: params.domain,
      country_code: params.countryCode,
      language_code: params.languageCode ?? null,
      status: "draft_ready",
      is_deleted: 0,
      created_at: { gt: cutoff },
      generation_mode: params.generationMode,
    },
    orderBy: { created_at: "desc" },
    take: 10,
  });

  return candidates.find(isReusableDraftCacheCandidate) ?? null;
}

type SourceDraft = NonNullable<Awaited<ReturnType<typeof findReusableReadyDraft>>>;

/**
 * 基于命中缓存的历史 draft 克隆出新 draft（归属当前员工）。
 *
 * `completed_stages` 设成 `DRAFT_STAGES` 全量、`current_stage = null`、`status = 'draft_ready'`，
 * 后台 runner 的抢锁查询按 `status='draft_generating'` 挑活，所以克隆出来的草稿不会被再推进。
 * `raw_payload_excerpt` 标注来源 draft id，方便排障与审计。
 */
export async function createDraftFromCache(input: {
  userId: bigint;
  userMerchantId?: bigint | null;
  campaignId?: bigint | null;
  domain: string;
  countryCode: string;
  languageCode?: string | null;
  source: SourceDraft;
  landingPageUrl?: string | null;
  /**
   * 当前用户在「验证链接」时刻预生成的默认广告系列名。
   *
   * 不复用 `source.default_campaign_name`：那是历史 draft 当时为别的 team/user
   * 算出的"已用过的"名字，序号/MMDD/联盟序号都已过期，照搬过来会导致 PublishTab
   * 默认值不可用。空值时由 PublishTab 在加载草稿后兜底调一次预览接口。
   */
  defaultCampaignName?: string | null;
}) {
  const { source } = input;
  const landingPageUrl = input.landingPageUrl ?? source.landing_page_url;
  const previewPayload = stripSitelinksFromCachedPreview(source.preview_payload, input.landingPageUrl);

  return prisma.ad_creation_drafts.create({
    data: {
      user_id: input.userId,
      user_merchant_id: input.userMerchantId ?? null,
      campaign_id: input.campaignId ?? null,
      domain: input.domain,
      country_code: input.countryCode,
      language_code: input.languageCode ?? null,
      status: "draft_ready",
      current_stage: null,
      completed_stages: DRAFT_STAGES as unknown as Prisma.InputJsonValue,
      landing_page_url: landingPageUrl,
      core_brand_keywords: (source.core_brand_keywords ?? []) as Prisma.InputJsonValue,
      source_payload: (source.source_payload ?? {}) as Prisma.InputJsonValue,
      sitelink_source_payload:
        (source.sitelink_source_payload ?? {}) as Prisma.InputJsonValue,
      headlines: (source.headlines ?? []) as Prisma.InputJsonValue,
      descriptions: (source.descriptions ?? []) as Prisma.InputJsonValue,
      sitelinks: [] as Prisma.InputJsonValue,
      preview_payload: previewPayload as Prisma.InputJsonValue,
      gap_report:
        source.gap_report == null
          ? undefined
          : (source.gap_report as Prisma.InputJsonValue),
      negative_keywords:
        source.negative_keywords == null
          ? undefined
          : (source.negative_keywords as Prisma.InputJsonValue),
      generation_mode: source.generation_mode,
      default_campaign_name: input.defaultCampaignName ?? null,
      raw_payload_excerpt: `reused_from_draft:${source.id.toString()}`,
    },
  });
}
