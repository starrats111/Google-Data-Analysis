/**
 * 品牌评估类型定义 —— 对齐 reusable/brand_serp/品牌预估提示词.md v2 与
 * reusable/brand_serp/brand_signal_collector.py 的 derive 输出。
 *
 * 纯类型文件，无运行时依赖。
 */

// ============================================================================
// Engine status
// ============================================================================

export type EngineState = "ok" | "failed" | "insufficient" | "empty" | "skipped";

export interface EngineStatus {
  serp: EngineState;
  trends: EngineState;
  transparency: EngineState;
  autocomplete: EngineState;
  llm: EngineState;
}

// ============================================================================
// Country params
// ============================================================================

export interface CountryParams {
  gl: string; // SerpApi geolocation
  hl: string; // SerpApi UI language
  google_domain: string;
  trends_geo: string; // Google Trends geo parameter (ISO-like, e.g. UK -> GB)
  /** SerpApi `location` 参数（`engine=google_ads` 必填，如 "United States"）。 */
  serpapi_location: string;
  isFallback: boolean; // true if unknown country → fell back to US default
}

// ============================================================================
// Raw / normalized ad entry (对齐 Python _normalize_ad_entry)
// ============================================================================

export interface AdSitelink {
  title: string | null;
  snippet: string | null;
}

export interface AdEntry {
  title: string;
  description: string;
  displayed_url: string;
  link: string;
  block_position: string | null;
  position: number | null;
  sitelinks: AdSitelink[];
  sitelinks_count: number;
  callouts: string[];
  callouts_count: number;
  price_extension: unknown;
  promotion_extension: unknown;
  extensions_raw: unknown;
  pixel_position_y: number | null;
  above_the_fold: boolean;
}

// ============================================================================
// Country snapshot (对齐 Python derive_country_snapshot —— 字段名与 Python 一致)
// ============================================================================

/**
 * serp_snapshot 的 JSON-ish 形状。字段由 derive.ts 产出：
 *   ads_top_count, ads_bottom_count, brand_own_ads_count, non_brand_ads_count,
 *   shopping_block_present, shopping_ads_count, knowledge_graph_present,
 *   answer_box_present, local_pack_present, top_story_present,
 *   video_block_present, organic_top1_is_brand, organic_top1_sitelinks_count,
 *   total_results, above_the_fold_ad_count, above_the_fold_brand_own,
 *   organic_top1_pixel_y
 */
export type CountrySnapshot = Record<string, unknown>;

// ============================================================================
// Trends / Transparency / Autocomplete (字段名对齐 Python derive_brand_level)
// ============================================================================

export type TrendDirection = "rising" | "declining" | "stable";

/**
 * trends JSON-ish:
 *   { interest_score_0_100, trend_direction, seasonality_peak_month,
 *     interest_by_region_top5: [{ region, value }] }
 */
export type TrendsData = Record<string, unknown>;

/**
 * transparency JSON-ish:
 *   { brand_advertised_in_country, brand_ads_history_days,
 *     creative_refresh_per_month, platforms: string[] }
 */
export type TransparencyCreativeStats = Record<string, unknown>;

export interface AutocompleteVariant {
  seed: string;
  suggestion: string;
}

// ============================================================================
// Brand level (对齐 Python derive_brand_level)
// ============================================================================

export interface BrandLevel {
  trends: TrendsData | null;
  transparency: TransparencyCreativeStats | null;
}

// ============================================================================
// LLM I/O
// ============================================================================

export type RecommendedAction =
  | "launch_now"
  | "launch"
  | "test_small"
  | "do_not_launch";

export type Priority = "high" | "medium" | "low";

export interface LlmScores {
  commercial_activity: number; // 0-10 integer
  interceptability: number; // 0-10 integer
  official_pressure: number; // 0-10 integer
  intent_expansion: number; // 0-10 integer
  country_fit: number; // 0-10 integer
  observable_arbitrage_score: number; // 0-50 integer
}

export interface LlmDecision {
  recommended_action: RecommendedAction;
  priority: Priority;
  arbitrage_level:
    | "high_potential"
    | "testable"
    | "cautious_test"
    | "low_potential";
  test_directions?: string[];
  do_not_launch_reason?: string;
}

export interface LlmReasons {
  commercial_activity_reason?: string;
  interceptability_reason?: string;
  official_pressure_reason?: string;
  intent_expansion_reason?: string;
  country_fit_reason?: string;
}

export interface LlmProfitProjection {
  projection_available: boolean;
  reason_if_unavailable?: string;
  projected_clicks?: number;
  projected_ad_cost?: number;
  projected_conversions?: number;
  projected_gross_profit?: number;
  projected_net_profit?: number;
  projected_roi?: number;
  projected_roas?: number;
}

export interface LlmMetadata {
  brand_token: string;
  industry?: string;
  is_strong_brand_entity?: boolean;
  target_language?: string;
}

export interface LlmOutput {
  metadata: LlmMetadata;
  scores: LlmScores;
  reasons: LlmReasons;
  decision: LlmDecision;
  profit_projection: LlmProfitProjection;
  data_completeness: number; // 0-1
}

// ============================================================================
// Engine input / output (engine.ts 契约)
// ============================================================================

export interface BrandAssessmentEngineInput {
  /** 发起人，仅审计用；评估结果按 (域名, 国家) 全公司共享，不按人隔离 */
  userId?: bigint | null;
  jobId?: bigint;
  domain: string;
  country: string; // ISO-2
  forceRefresh: boolean;
}

export interface BrandAssessmentEngineOutput {
  status: "ok" | "partial" | "failed" | "cost_aborted";
  source: "fresh" | "cache_hit";
  engineStatus: EngineStatus;
  resultId: bigint | null;
  llmOutput: LlmOutput | null;
  warnings: string[];
  serpapiCostUsd: number;
  llmCostUsd: number;
  errorMessage?: string;
}
