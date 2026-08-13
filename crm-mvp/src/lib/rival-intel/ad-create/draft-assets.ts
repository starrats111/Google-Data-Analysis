import { buildPreviewPayload } from "./preview-builder";
import { sanitizeSitelinks, type DraftSitelink } from "./sitelink-policy";
import {
  normalizeDescriptions,
  normalizeHeadlines,
  normalizeSitelinks,
  type DescriptionItem,
  type HeadlineItem,
  type SitelinkItem,
} from "./normalize-items";
import type { GapReport } from "./gap-report";
import { DESCRIPTIONS_MIN_REQUIRED, HEADLINES_MIN_REQUIRED } from "./gap-report";

function uniqueNonEmptyStrings(raw: unknown, fallback: string[]): string[] {
  const source = Array.isArray(raw) ? raw : fallback;
  const seen = new Set<string>();
  const result: string[] = [];

  for (const item of source) {
    const value = String(item ?? "").trim();
    const key = value.toLowerCase();
    if (!value || seen.has(key)) continue;
    seen.add(key);
    result.push(value);
  }

  return result;
}

function toDraftSitelinks(items: SitelinkItem[]): DraftSitelink[] {
  return items.map((item) => ({
    linkText: item.linkText,
    finalUrl: item.finalUrl,
    ...(item.description1 ? { description1: item.description1 } : {}),
    ...(item.description2 ? { description2: item.description2 } : {}),
  }));
}

export function buildDraftAssetPatch(input: {
  domain: string;
  landingPageUrl?: string | null;
  existingHeadlines: unknown;
  existingDescriptions: unknown;
  existingSitelinks: unknown;
  existingBrandKeywords: unknown;
  gapReport: GapReport | null;
  negativeKeywords: string[] | null;
  body: unknown;
}): {
  coreBrandKeywords: string[];
  headlines: HeadlineItem[];
  descriptions: DescriptionItem[];
  sitelinks: DraftSitelink[];
  gapReport: GapReport | null;
  previewPayload: ReturnType<typeof buildPreviewPayload>;
} {
  const body = input.body && typeof input.body === "object" ? input.body as Record<string, unknown> : {};
  const existingKeywords = Array.isArray(input.existingBrandKeywords)
    ? input.existingBrandKeywords.map((item) => String(item ?? ""))
    : [];

  const coreBrandKeywords = uniqueNonEmptyStrings(body.coreBrandKeywords, existingKeywords);
  const headlines = normalizeHeadlines(Array.isArray(body.headlines) ? body.headlines : input.existingHeadlines);
  const descriptions = normalizeDescriptions(
    Array.isArray(body.descriptions) ? body.descriptions : input.existingDescriptions,
  );
  const sitelinkItems = normalizeSitelinks(Array.isArray(body.sitelinks) ? body.sitelinks : input.existingSitelinks);
  const sitelinks = sanitizeSitelinks(toDraftSitelinks(sitelinkItems));
  const gapReport =
    headlines.length >= HEADLINES_MIN_REQUIRED && descriptions.length >= DESCRIPTIONS_MIN_REQUIRED
      ? null
      : input.gapReport;

  const previewPayload = buildPreviewPayload({
    domain: input.domain,
    landingPageUrl: input.landingPageUrl,
    headlines: headlines.map((item) => item.text),
    descriptions: descriptions.map((item) => item.text),
    brandKeywords: coreBrandKeywords,
    sitelinks,
    gapReport,
    negativeKeywords: input.negativeKeywords,
  });

  return { coreBrandKeywords, headlines, descriptions, sitelinks, gapReport, previewPayload };
}
