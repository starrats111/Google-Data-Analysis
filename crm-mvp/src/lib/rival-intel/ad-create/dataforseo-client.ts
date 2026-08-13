/**
 * @fileoverview DataForSEO Labs - Google Ranked Keywords Live HTTP 客户端。
 *
 * Phase B 的 ad-create 品牌词数据源（spec §5.1-§5.5）：
 *   - §5.1 Endpoint：`POST /v3/dataforseo_labs/google/ranked_keywords/live`
 *   - §5.2 鉴权：HTTP Basic（base64(login:password)）
 *   - §5.3 请求体：固定按 `etv desc` 排序，`organic` 过滤，`ignore_synonyms`
 *   - §5.4 响应：取 `tasks[0]` → `result[0].items[]` 抽取四元组
 *   - §5.5 错误：HTTP 非 200、`status_code !== 20000` 抛错；空数据返回空集
 *
 * 设计采用纯 DI：`fetchRankedKeywords` 强制要求调用方注入 `httpPost`，
 * 不在内部内置默认实现，方便单元测试零网络运行。生产代码请通过
 * 单独导出的 `defaultHttpPost(timeoutMs)` 自行装配 deps。
 */

const RANKED_KEYWORDS_URL =
  "https://api.dataforseo.com/v3/dataforseo_labs/google/ranked_keywords/live";

const DEFAULT_TIMEOUT_MS = 30_000;

const HTTP_ERROR_BODY_SNIPPET_LEN = 200;

/**
 * 单条排名关键词的归一化输出。
 *
 * 字段映射：
 *   - `keyword` ← `keyword_data.keyword`
 *   - `etv` ← `ranked_serp_element.serp_item.etv ?? 0`
 *   - `searchVolume` ← `keyword_data.keyword_info.search_volume ?? 0`
 *   - `rank` ← `ranked_serp_element.serp_item.rank_absolute ?? 0`
 */
export type RankedKeyword = {
  keyword: string;
  etv: number;
  searchVolume: number;
  rank: number;
};

/**
 * `fetchRankedKeywords` 入参。`target` 通常为去 `www.` 前缀的根域名；
 * `locationCode` / `languageCode` 由 `dataforseo-country-params` 映射给出。
 */
export interface FetchRankedKeywordsArgs {
  target: string;
  locationCode: number;
  languageCode: string;
  limit: number;
  credentials: { login: string; password: string };
}

/**
 * `fetchRankedKeywords` 依赖注入。`httpPost` 必须由调用方提供（无默认值），
 * 测试可注入 fake，生产请使用 `defaultHttpPost` 工厂。
 */
export interface FetchRankedKeywordsDeps {
  httpPost: (
    url: string,
    headers: Record<string, string>,
    body: string,
  ) => Promise<{ status: number; body: string }>;
}

/**
 * `fetchRankedKeywords` 出参。`costUsd` 来自 `tasks[0].cost`，
 * 用于上游记录 DataForSEO 计费成本（即便 `items` 为空仍可有费用）。
 */
export interface FetchRankedKeywordsResult {
  items: RankedKeyword[];
  costUsd: number;
}

type DfsTask = {
  status_code?: unknown;
  status_message?: unknown;
  cost?: unknown;
  result?: unknown;
};

type DfsResponse = { tasks: DfsTask[] };

type DfsItem = {
  keyword_data?: {
    keyword?: unknown;
    keyword_info?: { search_volume?: unknown };
  };
  ranked_serp_element?: {
    serp_item?: { etv?: unknown; rank_absolute?: unknown };
  };
};

/**
 * 调用 DataForSEO Labs Ranked Keywords Live 接口并返回归一化结果。
 *
 * 行为约束（spec §5.5）：
 *   - HTTP 非 200 → 抛 `dataforseo: http <status> — <body snippet>`
 *   - 响应整体形状不合法（非对象 / 缺 `tasks` 数组）→ 抛 `dataforseo: invalid response shape`
 *   - `tasks` 为空数组 → 抛 `dataforseo: empty tasks`
 *   - `tasks[0].status_code !== 20000` → 抛 `dataforseo: task status <code> <msg>`
 *   - `result == null` 或 `items` 缺失/空 → 返回 `{ items: [], costUsd }`（不抛错）
 *
 * @param args 查询参数与 Basic Auth 凭据
 * @param deps 依赖注入；必须提供 `httpPost`
 * @returns 归一化的关键词数组与本次调用的计费成本
 */
export async function fetchRankedKeywords(
  args: FetchRankedKeywordsArgs,
  deps: FetchRankedKeywordsDeps,
): Promise<FetchRankedKeywordsResult> {
  const body = JSON.stringify([
    {
      target: args.target,
      location_code: args.locationCode,
      language_code: args.languageCode,
      limit: args.limit,
      order_by: ["ranked_serp_element.serp_item.etv,desc"],
      filters: [["ranked_serp_element.serp_item.type", "=", "organic"]],
      ignore_synonyms: true,
      load_rank_absolute: true,
    },
  ]);

  const authToken = Buffer.from(
    `${args.credentials.login}:${args.credentials.password}`,
  ).toString("base64");

  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Authorization: `Basic ${authToken}`,
  };

  const { status, body: responseBody } = await deps.httpPost(
    RANKED_KEYWORDS_URL,
    headers,
    body,
  );

  if (status !== 200) {
    const snippet = responseBody
      .slice(0, HTTP_ERROR_BODY_SNIPPET_LEN)
      .replace(/\s+/g, " ")
      .trim();
    throw new Error(
      `dataforseo: http ${status}${snippet ? ` — ${snippet}` : ""}`,
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(responseBody);
  } catch {
    throw new Error("dataforseo: invalid response shape");
  }

  if (
    parsed === null ||
    typeof parsed !== "object" ||
    !Array.isArray((parsed as { tasks?: unknown }).tasks)
  ) {
    throw new Error("dataforseo: invalid response shape");
  }

  const tasks = (parsed as DfsResponse).tasks;
  if (tasks.length === 0) {
    throw new Error("dataforseo: empty tasks");
  }

  const task: DfsTask = tasks[0];
  if (task.status_code !== 20000) {
    const code = task.status_code ?? "?";
    const msg = typeof task.status_message === "string" ? task.status_message : "";
    throw new Error(`dataforseo: task status ${code} ${msg}`.trim());
  }

  const costUsd = pickFiniteNumber(task.cost);

  const result = task.result as Array<{ items?: unknown }> | null | undefined;
  const firstResult = Array.isArray(result) ? result[0] : null;

  if (
    result == null ||
    firstResult == null ||
    firstResult.items == null ||
    !Array.isArray(firstResult.items)
  ) {
    return { items: [], costUsd };
  }

  const items: RankedKeyword[] = (firstResult.items as unknown[]).map(
    (item) => extractRankedKeyword(item),
  );

  return { items, costUsd };
}

/**
 * 创建生产用 `httpPost` 实现：基于全局 `fetch` + `AbortSignal.timeout`
 * 的超时控制（Node 20+ 内置）。不内置进 `fetchRankedKeywords` 是因为
 * DI 是该模块的硬约束 —— 强制消费方在装配阶段显式选择实现，便于测试
 * 与重试装饰。
 *
 * @param timeoutMs 超时时间（毫秒），默认 30000
 * @returns 满足 `FetchRankedKeywordsDeps["httpPost"]` 签名的函数
 */
export function defaultHttpPost(
  timeoutMs: number = DEFAULT_TIMEOUT_MS,
): FetchRankedKeywordsDeps["httpPost"] {
  return async (url, headers, body) => {
    try {
      const response = await fetch(url, {
        method: "POST",
        headers,
        body,
        signal: AbortSignal.timeout(timeoutMs),
      });
      const text = await response.text();
      return { status: response.status, body: text };
    } catch (error) {
      const name = (error as { name?: string } | null)?.name;
      if (name === "TimeoutError" || name === "AbortError") {
        throw new Error("dataforseo: timeout");
      }
      throw error;
    }
  };
}

function pickFiniteNumber(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function extractRankedKeyword(item: unknown): RankedKeyword {
  if (item == null || typeof item !== "object") {
    return { keyword: "", etv: 0, searchVolume: 0, rank: 0 };
  }

  const dfsItem = item as DfsItem;
  const keyword = dfsItem.keyword_data?.keyword;
  const serpItem = dfsItem.ranked_serp_element?.serp_item;

  return {
    keyword: typeof keyword === "string" ? keyword : "",
    etv: pickFiniteNumber(serpItem?.etv),
    searchVolume: pickFiniteNumber(dfsItem.keyword_data?.keyword_info?.search_volume),
    rank: pickFiniteNumber(serpItem?.rank_absolute),
  };
}
