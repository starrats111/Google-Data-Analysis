export type DraftStatus = "draft_generating" | "draft_ready" | "draft_failed";

export type PublishJobStatus = "pending" | "publishing" | "success" | "failed";

/**
 * D-233：第一阶段原名 `fetch_3ue`（3UE 是 kyads 早年的竞品爬虫供应商，会话 403
 * 之后整条路径就废了，实际读的是品牌评估结果 + SerpApi）。CRM 这边是新建表、没有
 * 存量数据要兼容，所以顺手改成 `fetch_rival_ads`，不再留死供应商的名字。
 */
export type DraftStage =
  | "fetch_rival_ads"
  | "extract_brand_keywords"
  | "discover_sitelink_urls"
  | "ai_generate_assets"
  | "build_preview";

export const DRAFT_STAGES: DraftStage[] = [
  "fetch_rival_ads",
  "extract_brand_keywords",
  "discover_sitelink_urls",
  "ai_generate_assets",
  "build_preview",
];

export type PublishStage =
  | "validate_cid"
  | "build_operations"
  | "publish_google_ads"
  | "write_back";

export const PUBLISH_STAGES: PublishStage[] = [
  "validate_cid",
  "build_operations",
  "publish_google_ads",
  "write_back",
];

export type BrandKeywordExtractionSource =
  | "dataforseo+ai"
  | "brand_token_fallback"
  | "domain_fallback"
  | "budget_exceeded_fallback"
  | "credentials_missing_fallback";

export interface BrandKeywordExtractionRecord {
  source: BrandKeywordExtractionSource;
  topKeywords: Array<{
    keyword: string;
    etv: number;
    searchVolume: number;
    rank: number;
  }>;
  aiResult: {
    brandKeywords: string[];
    hasBrand: boolean;
    reasoning: string;
  } | null;
  fallbackReason: string | null;
  fetchedAt: string;
  cacheHit: boolean;
}
