import type { DraftSitelink } from "./sitelink-policy";
import type { GapReport } from "./gap-report";

export interface AdPreview {
  domain: string;
  landingPageUrl: string;
  displayUrl: string;
  previewHeadline: string;
  previewDescription: string;
  headlines: string[];
  descriptions: string[];
  brandKeywords: string[];
  sitelinks: DraftSitelink[];
  gapReport: GapReport | null;
  negativeKeywords: string[] | null;
}

export function buildPreviewPayload(input: {
  domain: string;
  landingPageUrl?: string | null;
  headlines: string[];
  descriptions: string[];
  brandKeywords: string[];
  sitelinks?: DraftSitelink[];
  gapReport?: GapReport | null;
  negativeKeywords?: string[] | null;
}): AdPreview {
  const displayUrl = input.domain.replace(/^https?:\/\//, "").replace(/\/+$/, "");
  const landingPageUrl = input.landingPageUrl?.trim()
    || (input.domain.startsWith("http") ? input.domain : `https://${displayUrl}`);
  return {
    domain: input.domain,
    landingPageUrl,
    displayUrl,
    previewHeadline: input.headlines.slice(0, 3).join(" | "),
    previewDescription: input.descriptions.slice(0, 2).join(" "),
    headlines: input.headlines,
    descriptions: input.descriptions,
    brandKeywords: input.brandKeywords,
    sitelinks: input.sitelinks || [],
    gapReport: input.gapReport ?? null,
    negativeKeywords: input.negativeKeywords ?? null,
  };
}

export const buildAdPreview = buildPreviewPayload;
