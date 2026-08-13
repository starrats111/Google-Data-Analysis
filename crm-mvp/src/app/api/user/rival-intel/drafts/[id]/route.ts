/**
 * 竞品情报草稿详情 / 编辑。
 *
 * D-233：kyads 的同名接口每被 GET 一次就推进一个生成阶段，靠前端每 2 秒轮询把五个阶段
 * 点完——关页面就烂尾。CRM 这里 GET 是**纯读**，阶段由 `draft-generation-runner`
 * 在后台推进，前端轮询只是看进度。唯一的例外是失败重试：员工点重试时把草稿状态复位并
 * 重新入队，仍然由后台跑。
 */
import { NextRequest } from "next/server";
import { apiError, apiSuccess } from "@/lib/constants";
import { withUser } from "@/lib/api-handler";
import { serializeData } from "@/lib/auth";
import { getDraftById, updateDraft } from "@/lib/rival-intel/ad-create/repository";
import { buildDraftAssetPatch } from "@/lib/rival-intel/ad-create/draft-assets";
import {
  normalizeDescriptions,
  normalizeHeadlines,
  normalizeSitelinks,
} from "@/lib/rival-intel/ad-create/normalize-items";
import type { GapReport } from "@/lib/rival-intel/ad-create/gap-report";
import { DRAFT_STAGES } from "@/lib/rival-intel/ad-create/types";

type CompletedEntry = string | { stage: string; skipped?: boolean };

function toDto(draft: NonNullable<Awaited<ReturnType<typeof getDraftById>>>) {
  const completed = (draft.completed_stages as CompletedEntry[] | null) ?? [];
  return {
    id: draft.id.toString(),
    campaign_id: draft.campaign_id?.toString() ?? null,
    user_merchant_id: draft.user_merchant_id?.toString() ?? null,
    domain: draft.domain,
    country_code: draft.country_code,
    language_code: draft.language_code,
    landing_page_url: draft.landing_page_url,
    status: draft.status,
    current_stage: draft.current_stage,
    completed_stages: completed,
    // 前端进度条按「已完成阶段数 / 总阶段数」画，不用再各自硬编码阶段表
    total_stages: DRAFT_STAGES.length,
    failed_stage: draft.failed_stage,
    error_message: draft.error_message,
    retryable: draft.retryable === 1,
    generation_mode: draft.generation_mode,
    core_brand_keywords: draft.core_brand_keywords,
    headlines: normalizeHeadlines(draft.headlines),
    descriptions: normalizeDescriptions(draft.descriptions),
    sitelinks: normalizeSitelinks(draft.sitelinks),
    negative_keywords: Array.isArray(draft.negative_keywords) ? draft.negative_keywords : [],
    preview_payload: draft.preview_payload,
    gap_report: draft.gap_report ?? null,
    created_at: draft.created_at,
    updated_at: draft.updated_at,
  };
}

export const GET = withUser(async (_req: NextRequest, { user, params }) => {
  const id = params?.id;
  if (!id) return apiError("缺少草稿 ID");

  const draft = await getDraftById(BigInt(id));
  if (!draft) return apiError("草稿不存在", 404);
  if (draft.user_id !== BigInt(user.userId)) return apiError("草稿不存在", 404);

  return apiSuccess(serializeData(toDto(draft)));
});

/**
 * 员工在预览步骤改文案。走 kyads 的 `buildDraftAssetPatch`：它会做长度校验、
 * 去重、RSA 下限检查，并顺手重算 preview_payload，所以这里不额外拼预览体。
 */
export const PATCH = withUser(async (req: NextRequest, { user, params }) => {
  const id = params?.id;
  if (!id) return apiError("缺少草稿 ID");

  const draftId = BigInt(id);
  const draft = await getDraftById(draftId);
  if (!draft) return apiError("草稿不存在", 404);
  if (draft.user_id !== BigInt(user.userId)) return apiError("草稿不存在", 404);

  const body = await req.json();
  let patch;
  try {
    patch = buildDraftAssetPatch({
      domain: draft.domain,
      landingPageUrl: draft.landing_page_url,
      existingHeadlines: draft.headlines,
      existingDescriptions: draft.descriptions,
      existingSitelinks: draft.sitelinks,
      existingBrandKeywords: draft.core_brand_keywords,
      gapReport: (draft.gap_report as GapReport | null) ?? null,
      negativeKeywords: Array.isArray(draft.negative_keywords)
        ? (draft.negative_keywords as string[])
        : null,
      body,
    });
  } catch (err) {
    return apiError(err instanceof Error ? err.message : "草稿内容不合法", 422);
  }

  const updated = await updateDraft(draftId, {
    core_brand_keywords: patch.coreBrandKeywords,
    headlines: patch.headlines,
    descriptions: patch.descriptions,
    sitelinks: patch.sitelinks,
    gap_report: patch.gapReport,
    preview_payload: patch.previewPayload,
  });

  return apiSuccess(serializeData(toDto(updated)), "已保存");
});
