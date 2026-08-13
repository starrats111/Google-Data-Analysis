import { normalizeDescriptions, normalizeHeadlines } from "./normalize-items";

type CacheCandidate = {
  generation_mode?: unknown;
  gap_report?: unknown | null;
  source_payload?: unknown | null;
  headlines?: unknown;
  descriptions?: unknown;
  preview_payload?: unknown | null;
};

const HEADLINES_MIN_REQUIRED = 3;
const DESCRIPTIONS_MIN_REQUIRED = 2;

function hasBrokenRsaMinimum(gapReport: unknown): boolean {
  if (!gapReport || typeof gapReport !== "object" || Array.isArray(gapReport)) {
    return false;
  }
  return (gapReport as { breaksRsaMinimum?: unknown }).breaksRsaMinimum === true;
}

function hasSourceBrandToken(sourcePayload: unknown): boolean {
  if (!sourcePayload || typeof sourcePayload !== "object" || Array.isArray(sourcePayload)) {
    return false;
  }
  const brandToken = (sourcePayload as { brandToken?: unknown }).brandToken;
  return typeof brandToken === "string" && brandToken.trim().length > 0;
}

function hasPreviewAssetMinimum(previewPayload: unknown): boolean {
  if (!previewPayload || typeof previewPayload !== "object" || Array.isArray(previewPayload)) {
    return false;
  }
  const preview = previewPayload as { headlines?: unknown; descriptions?: unknown };
  return (
    Array.isArray(preview.headlines) &&
    preview.headlines.length >= HEADLINES_MIN_REQUIRED &&
    Array.isArray(preview.descriptions) &&
    preview.descriptions.length >= DESCRIPTIONS_MIN_REQUIRED
  );
}

function hasActualAssetMinimum(candidate: CacheCandidate): boolean {
  return (
    normalizeHeadlines(candidate.headlines).length >= HEADLINES_MIN_REQUIRED &&
    normalizeDescriptions(candidate.descriptions).length >= DESCRIPTIONS_MIN_REQUIRED &&
    hasPreviewAssetMinimum(candidate.preview_payload)
  );
}

export function isReusableDraftCacheCandidate(candidate: CacheCandidate): boolean {
  if (!hasSourceBrandToken(candidate.source_payload)) {
    return false;
  }
  if (!hasActualAssetMinimum(candidate)) {
    return false;
  }
  if (candidate.generation_mode === "filter" && hasBrokenRsaMinimum(candidate.gap_report)) {
    return false;
  }
  return true;
}

/**
 * 复用历史草稿时清空预览里的站内链接，避免旧缓存绕过默认禁用策略。
 */
export function stripSitelinksFromCachedPreview(
  previewPayload: unknown,
  landingPageUrl?: string | null,
): Record<string, unknown> {
  const preview =
    previewPayload && typeof previewPayload === "object" && !Array.isArray(previewPayload)
      ? { ...(previewPayload as Record<string, unknown>) }
      : {};
  if (landingPageUrl) {
    preview.landingPageUrl = landingPageUrl;
  }
  preview.sitelinks = [];
  return preview;
}
