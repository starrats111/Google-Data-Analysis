/**
 * SerpApi 客户端。依赖注入 httpGet 以便 mock。
 *
 * 对齐 Python `_http_get_json` / `preflight_check_api_key` / `fetch_serp`
 * / `fetch_trends` / `fetch_transparency` / `fetch_autocomplete_variants`。
 *
 * 设计要点：
 *   - 401/403 立即抛 `SerpApiAuthError`，不消耗重试次数（避免把 API 预算浪费在
 *     凭证错误上）
 *   - 其它失败（网络 / 5xx / 非法 JSON）：线性退避重试，全败返回 `status:"failed"`
 *   - 不直接依赖 `globalThis.fetch`，所有 HTTP 通过注入 `httpGet`
 */

export const SERPAPI_BASE_URL = "https://serpapi.com/search.json";
export const SERPAPI_ACCOUNT_URL = "https://serpapi.com/account.json";
export const AUTOCOMPLETE_URL =
  "https://suggestqueries.google.com/complete/search";

/** 按 §11.1，每次付费引擎调用 = $0.015。autocomplete 走 Google 公开接口，0 成本。 */
export const SERPAPI_COST_PER_QUERY_USD = 0.015;

// ============================================================================
// Errors & helpers
// ============================================================================

export class SerpApiAuthError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SerpApiAuthError";
  }
}

export interface HttpGetResponse {
  status: number;
  body: string;
}

export type HttpGet = (url: string, timeoutMs: number) => Promise<HttpGetResponse>;

export type SleepFn = (ms: number) => Promise<void>;

export const defaultSleep: SleepFn = (ms) =>
  new Promise((r) => setTimeout(r, ms));

function buildUrl(base: string, params: Record<string, unknown>): string {
  const usp = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v == null || v === "") continue;
    usp.set(k, String(v));
  }
  return `${base}?${usp.toString()}`;
}

// ============================================================================
// Low-level GET with retries
// ============================================================================

export interface FetchResult<T = unknown> {
  status: "ok" | "failed";
  data: T | null;
  error?: string;
  httpStatus?: number;
  costUsd: number;
}

export interface SerpApiDeps {
  httpGet: HttpGet;
  sleep?: SleepFn;
  retries?: number;
  timeoutMs?: number;
  backoffBaseMs?: number;
}

async function httpGetJson<T>(
  url: string,
  deps: Required<
    Pick<SerpApiDeps, "httpGet" | "sleep" | "retries" | "timeoutMs" | "backoffBaseMs">
  >,
): Promise<{ ok: true; data: T } | { ok: false; error: string; status?: number }> {
  let lastErr: string = "unknown";
  let lastStatus: number | undefined;
  for (let attempt = 0; attempt <= deps.retries; attempt++) {
    try {
      const res = await deps.httpGet(url, deps.timeoutMs);
      if (res.status === 401 || res.status === 403) {
        throw new SerpApiAuthError(
          `SerpApi auth failed (HTTP ${res.status}): ${res.body.slice(0, 200)}`,
        );
      }
      if (res.status >= 200 && res.status < 300) {
        try {
          return { ok: true, data: JSON.parse(res.body) as T };
        } catch {
          lastErr = "invalid JSON body";
          lastStatus = res.status;
        }
      } else {
        lastErr = `HTTP ${res.status}: ${res.body.slice(0, 200)}`;
        lastStatus = res.status;
      }
    } catch (e) {
      if (e instanceof SerpApiAuthError) throw e;
      lastErr = e instanceof Error ? e.message : String(e);
    }
    if (attempt < deps.retries) {
      await deps.sleep(deps.backoffBaseMs * (attempt + 1));
    }
  }
  return { ok: false, error: lastErr, status: lastStatus };
}

// ============================================================================
// Preflight: /account must accept api_key
// ============================================================================

export async function preflightCheckApiKey(
  apiKey: string,
  deps: SerpApiDeps,
): Promise<void> {
  const full: Required<
    Pick<SerpApiDeps, "httpGet" | "sleep" | "retries" | "timeoutMs" | "backoffBaseMs">
  > = {
    httpGet: deps.httpGet,
    sleep: deps.sleep ?? defaultSleep,
    retries: deps.retries ?? 1,
    timeoutMs: deps.timeoutMs ?? 10_000,
    backoffBaseMs: deps.backoffBaseMs ?? 300,
  };
  const url = buildUrl(SERPAPI_ACCOUNT_URL, { api_key: apiKey });
  const r = await httpGetJson<Record<string, unknown>>(url, full);
  if (!r.ok) {
    throw new Error(`SerpApi preflight failed: ${r.error}`);
  }
}

// ============================================================================
// Engine callers
// ============================================================================

export interface CountryParamsLike {
  gl: string;
  hl: string;
  google_domain: string;
  trends_geo?: string;
  serpapi_location?: string;
}

export async function fetchSerp(params: {
  q: string;
  countryParams: CountryParamsLike;
  apiKey: string;
  deps: SerpApiDeps;
  includePixelPosition?: boolean;
  device?: "desktop" | "mobile";
  num?: number;
  hlOverride?: string | null;
}): Promise<FetchResult> {
  const {
    q,
    countryParams,
    apiKey,
    deps,
    includePixelPosition = true,
    device = "desktop",
    num = 20,
    hlOverride = null,
  } = params;

  const url = buildUrl(SERPAPI_BASE_URL, {
    engine: "google",
    q,
    gl: countryParams.gl,
    hl: hlOverride ?? countryParams.hl,
    google_domain: countryParams.google_domain,
    device,
    num,
    include_pixel_position: includePixelPosition ? "true" : undefined,
    api_key: apiKey,
  });

  const full = {
    httpGet: deps.httpGet,
    sleep: deps.sleep ?? defaultSleep,
    retries: deps.retries ?? 2,
    timeoutMs: deps.timeoutMs ?? 30_000,
    backoffBaseMs: deps.backoffBaseMs ?? 500,
  };
  const r = await httpGetJson<Record<string, unknown>>(url, full);
  if (r.ok) {
    return { status: "ok", data: r.data, costUsd: SERPAPI_COST_PER_QUERY_USD };
  }
  return {
    status: "failed",
    data: null,
    error: r.error,
    httpStatus: r.status,
    costUsd: SERPAPI_COST_PER_QUERY_USD, // 失败也扣——SerpApi 计费规则
  };
}

export async function fetchGoogleAds(params: {
  q: string;
  countryParams: CountryParamsLike;
  apiKey: string;
  deps: SerpApiDeps;
  device?: "desktop" | "tablet" | "mobile";
  location?: string | null;
}): Promise<FetchResult> {
  const {
    q,
    countryParams,
    apiKey,
    deps,
    device = "desktop",
    location = null,
  } = params;

  const resolvedLocation =
    location?.trim() ||
    countryParams.serpapi_location?.trim() ||
    null;

  const url = buildUrl(SERPAPI_BASE_URL, {
    engine: "google_ads",
    q,
    gl: countryParams.gl,
    hl: countryParams.hl,
    google_domain: countryParams.google_domain,
    location: resolvedLocation,
    device,
    api_key: apiKey,
  });

  const full = {
    httpGet: deps.httpGet,
    sleep: deps.sleep ?? defaultSleep,
    retries: deps.retries ?? 2,
    timeoutMs: deps.timeoutMs ?? 30_000,
    backoffBaseMs: deps.backoffBaseMs ?? 500,
  };
  const r = await httpGetJson<Record<string, unknown>>(url, full);
  if (r.ok) {
    return { status: "ok", data: r.data, costUsd: SERPAPI_COST_PER_QUERY_USD };
  }
  return {
    status: "failed",
    data: null,
    error: r.error,
    httpStatus: r.status,
    costUsd: SERPAPI_COST_PER_QUERY_USD,
  };
}

export async function fetchTrends(params: {
  brand: string;
  countryParams?: CountryParamsLike;
  apiKey: string;
  deps: SerpApiDeps;
}): Promise<FetchResult> {
  const { brand, countryParams, apiKey, deps } = params;
  const url = buildUrl(SERPAPI_BASE_URL, {
    engine: "google_trends",
    q: brand,
    data_type: "TIMESERIES",
    geo: countryParams?.trends_geo ?? countryParams?.gl.toUpperCase(),
    api_key: apiKey,
  });
  const full = {
    httpGet: deps.httpGet,
    sleep: deps.sleep ?? defaultSleep,
    retries: deps.retries ?? 2,
    timeoutMs: deps.timeoutMs ?? 30_000,
    backoffBaseMs: deps.backoffBaseMs ?? 500,
  };
  const r = await httpGetJson<Record<string, unknown>>(url, full);
  return r.ok
    ? { status: "ok", data: r.data, costUsd: SERPAPI_COST_PER_QUERY_USD }
    : { status: "failed", data: null, error: r.error, costUsd: SERPAPI_COST_PER_QUERY_USD };
}

/**
 * 调 SerpApi `google_ads_transparency_center` 引擎。
 *
 * **重要 (2026-05-16 修复)**：必须把整个域名（如 "aunubeauty.com"）作为
 * `text` 参数，**不能**用 `extractBrandName` 后的 brand token（如 "aunubeauty"）。
 *
 * 实测对照（6 种 query 变体诊断，2026-05-16）：
 *   - text=brandToken ("aunubeauty")      → 0 ad_creatives（"hasn't returned any results"）
 *   - text=domain     ("aunubeauty.com")  → 10 ad_creatives（含 non-brand advertiser）
 *   - text=brandFull  ("AUNU Beauty")     → 0
 *   - 任何 region=US/UK/... → 400 "Unsupported region parameter"
 *
 * 这正是 brand_assessment_results 表 transparency 字段历史 0% 命中的根因 —
 * 之前 385 行 transparency=0 不是数据稀薄，而是 query 参数错了。
 *
 * 故本函数：
 *   - 参数名为 `domain`（强类型约束调用方传整个域名，不再传 brand token）
 *   - 内部把 `domain` 直接放进 `text` query string
 *   - 不传 region（SerpApi 此引擎不接受 ISO 国家码）
 *
 * @param params.domain 完整域名（不含协议/路径），例如 "aunubeauty.com"
 * @param params.apiKey SerpApi api_key
 * @param params.deps   HTTP 注入与超时/重试配置
 */
export async function fetchTransparency(params: {
  domain: string;
  apiKey: string;
  deps: SerpApiDeps;
  advertiserId?: string | null;
  creativeFormat?: "text" | "image" | "video";
  platform?: "PLAY" | "MAPS" | "SEARCH" | "SHOPPING" | "YOUTUBE" | null;
  num?: number;
  nextPageToken?: string | null;
  region?: string | number | null;
}): Promise<FetchResult> {
  const {
    domain,
    apiKey,
    deps,
    advertiserId = null,
    creativeFormat = "text",
    platform = null,
    num = 100,
    nextPageToken = null,
    region = null,
  } = params;
  const url = buildUrl(SERPAPI_BASE_URL, {
    engine: "google_ads_transparency_center",
    text: advertiserId ? null : domain,
    advertiser_id: advertiserId,
    platform,
    region,
    creative_format: creativeFormat,
    num,
    next_page_token: nextPageToken,
    api_key: apiKey,
  });
  const full = {
    httpGet: deps.httpGet,
    sleep: deps.sleep ?? defaultSleep,
    retries: deps.retries ?? 2,
    timeoutMs: deps.timeoutMs ?? 30_000,
    backoffBaseMs: deps.backoffBaseMs ?? 500,
  };
  const r = await httpGetJson<Record<string, unknown>>(url, full);
  return r.ok
    ? { status: "ok", data: r.data, costUsd: SERPAPI_COST_PER_QUERY_USD }
    : { status: "failed", data: null, error: r.error, costUsd: SERPAPI_COST_PER_QUERY_USD };
}

/**
 * 调 Google 公开 suggest（autocomplete）。无需 SerpApi key → 0 成本。
 * 多个 seed：部分失败保留已收集，全败返回空数组（不抛）。
 */
export async function fetchAutocomplete(params: {
  brand: string;
  seeds: string[];
  countryParams: CountryParamsLike;
  deps: SerpApiDeps;
}): Promise<{
  status: "ok" | "partial" | "failed";
  suggestions: Array<{ seed: string; suggestion: string }>;
  costUsd: number;
}> {
  const { seeds, countryParams, deps } = params;
  const full = {
    httpGet: deps.httpGet,
    sleep: deps.sleep ?? defaultSleep,
    retries: deps.retries ?? 1,
    timeoutMs: deps.timeoutMs ?? 10_000,
    backoffBaseMs: deps.backoffBaseMs ?? 300,
  };
  const collected: Array<{ seed: string; suggestion: string }> = [];
  let failCount = 0;
  for (const seed of seeds) {
    const url = buildUrl(AUTOCOMPLETE_URL, {
      client: "firefox",
      q: seed,
      gl: countryParams.gl,
      hl: countryParams.hl,
    });
    const r = await httpGetJson<[unknown, unknown]>(url, full);
    if (!r.ok) {
      failCount += 1;
      continue;
    }
    const arr = Array.isArray(r.data) ? r.data : [];
    const suggestions = Array.isArray(arr[1]) ? (arr[1] as unknown[]) : [];
    for (const s of suggestions) {
      if (typeof s === "string" && s.trim()) {
        collected.push({ seed, suggestion: s.trim() });
      }
    }
  }
  let status: "ok" | "partial" | "failed" = "ok";
  if (failCount === seeds.length && seeds.length > 0) status = "failed";
  else if (failCount > 0) status = "partial";
  return { status, suggestions: collected, costUsd: 0 };
}
