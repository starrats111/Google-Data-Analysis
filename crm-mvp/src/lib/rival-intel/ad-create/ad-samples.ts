import type { AdEntry } from "@/lib/rival-intel/brand-assessment/types";
import type { AdGenerationMode } from "@/lib/rival-intel/deps/generation-mode";
import type { AdSample } from "./ai-asset-generator";

function splitFilterHeadline(title: string): string[] {
  return title
    .split(/\s+\|\s+|\s+[–—-]\s+/)
    .map((part) => part.trim())
    .filter(Boolean);
}

function splitFilterDescription(description: string): string[] {
  const parts = description.includes(".") ? description.split(".") : [description];
  return parts
    .map((part) => part.trim())
    .filter(Boolean)
    .map((part) => `${part}.`);
}

function pushUnique(samples: AdSample[], seen: Set<string>, sample: AdSample, key: string) {
  if (!sample.title && !sample.description) return;
  if (seen.has(key)) return;
  seen.add(key);
  samples.push(sample);
}

function flattenSitelinks(
  samples: AdSample[],
  seen: Set<string>,
  ad: AdEntry,
  isBrandOwn: boolean,
) {
  const sitelinks = Array.isArray(ad?.sitelinks) ? ad.sitelinks : [];
  for (const sl of sitelinks) {
    const slTitle = (sl?.title ?? "").toString().trim();
    const slDesc = (sl?.snippet ?? "").toString().trim();
    if (!slTitle && !slDesc) continue;
    pushUnique(
      samples,
      seen,
      {
        title: slTitle,
        description: slDesc,
        source: "sitelink",
        is_brand_own: isBrandOwn,
      },
      `sl|${slTitle.toLowerCase()}|${slDesc.toLowerCase()}`,
    );
  }
}

function flattenFilterAd(
  samples: AdSample[],
  seen: Set<string>,
  ad: AdEntry,
  isBrandOwn: boolean,
) {
  const title = (ad?.title ?? "").toString().trim();
  const description = (ad?.description ?? "").toString().trim();
  const displayedUrl = (ad?.displayed_url ?? "").toString().trim();

  for (const headline of splitFilterHeadline(title)) {
    pushUnique(
      samples,
      seen,
      {
        title: headline,
        description: "",
        source: "ad",
        is_brand_own: isBrandOwn,
        ...(displayedUrl ? { displayed_url: displayedUrl } : {}),
      },
      `ad-title|${headline.toLowerCase()}`,
    );
  }

  for (const desc of splitFilterDescription(description)) {
    pushUnique(
      samples,
      seen,
      {
        title: "",
        description: desc,
        source: "ad",
        is_brand_own: isBrandOwn,
        ...(displayedUrl ? { displayed_url: displayedUrl } : {}),
      },
      `ad-desc|${desc.toLowerCase()}`,
    );
  }
}

function flattenGenerateAd(
  samples: AdSample[],
  seen: Set<string>,
  ad: AdEntry,
  isBrandOwn: boolean,
) {
  const title = (ad?.title ?? "").toString().trim();
  const description = (ad?.description ?? "").toString().trim();
  const displayedUrl = (ad?.displayed_url ?? "").toString().trim();
  if (title || description) {
    pushUnique(
      samples,
      seen,
      {
        title,
        description,
        source: "ad",
        is_brand_own: isBrandOwn,
        ...(displayedUrl ? { displayed_url: displayedUrl } : {}),
      },
      `ad|${title.toLowerCase()}|${description.toLowerCase()}`,
    );
  }
}

/**
 * 把 `brand_own_ads` / `non_brand_ads` + 每条 ad 的 sitelinks 打平成 generator 输入。
 *
 * filter 模式只筛原文资产，因此需要把 Google/SerpApi 展示层合并的标题与描述拆回
 * 独立候选；ai_generate 模式保留原始整条广告作为生成上下文。
 */
export function buildAdSamples(input: {
  mode: AdGenerationMode;
  brandOwnAds: AdEntry[];
  nonBrandAds: AdEntry[];
}): AdSample[] {
  const samples: AdSample[] = [];
  const seen = new Set<string>();

  function flatten(ads: AdEntry[], isBrandOwn: boolean) {
    for (const ad of ads) {
      if (input.mode === "filter") {
        flattenFilterAd(samples, seen, ad, isBrandOwn);
      } else {
        flattenGenerateAd(samples, seen, ad, isBrandOwn);
      }
      flattenSitelinks(samples, seen, ad, isBrandOwn);
    }
  }

  flatten(Array.isArray(input.brandOwnAds) ? input.brandOwnAds : [], true);
  flatten(Array.isArray(input.nonBrandAds) ? input.nonBrandAds : [], false);
  return samples;
}
