/**
 * SWR 数据缓存层 — 解决页面切换重复请求的核心方案
 *
 * 原理：SWR 会在内存中缓存请求结果，页面切换回来时：
 * 1. 立即显示缓存数据（不白屏、不 loading）
 * 2. 后台静默重新验证（stale-while-revalidate）
 * 3. 如果数据有变化才更新 UI
 *
 * 对比老系统的问题：老系统每次切换都 loading → 请求 → 渲染，用户感知"卡"
 * 新系统：切换秒显 → 后台静默刷新 → 无感更新
 */

"use client";

import useSWR, { SWRConfiguration, mutate as globalMutate } from "swr";

// ─── 请求超时 ───
// 没有超时的 fetch 一旦挂住（上游被事件循环卡死、连接半开），promise 既不 resolve
// 也不 reject，SWR 的 isLoading 就永远是 true、errorRetryCount 也永远不触发——
// 页面转圈到天荒地老，只能手动刷新。给它一个上限，让失败变成"可重试的失败"。
// 60s 的依据：生产实测最慢的正常接口约 6.7s（商家拒付）/ 5.3s（500 条商家），
// 留了将近 10 倍余量，不会把"慢但正常"误判成失败。个别真的更慢的接口，
// 在调用处用 config.requestTimeoutMs 单独放宽，别动这个默认值。
const DEFAULT_TIMEOUT_MS = 60000;

export class RequestTimeoutError extends Error {
  constructor(public readonly url: string, public readonly timeoutMs: number) {
    super(`请求超时（${Math.round(timeoutMs / 1000)}秒未响应），请重试`);
    this.name = "RequestTimeoutError";
  }
}

// ─── 全局 fetcher ───
async function fetcher<T>(url: string, timeoutMs = DEFAULT_TIMEOUT_MS): Promise<T> {
  // AbortSignal.timeout 在超时后让 fetch 以 TimeoutError 形式 reject。
  // 这里统一转成 RequestTimeoutError，好让 UI 能认出"超时"并给出可重试的文案，
  // 而不是把它和 4xx/5xx 混在一起。
  let res: Response;
  try {
    res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
  } catch (e) {
    if (e instanceof DOMException && (e.name === "TimeoutError" || e.name === "AbortError")) {
      throw new RequestTimeoutError(url, timeoutMs);
    }
    throw e;
  }
  if (!res.ok) {
    if (res.status === 401) {
      // JWT 过期或无效 — 跳转到对应登录页
      if (typeof window !== "undefined") {
        const isAdmin = url.includes("/api/admin");
        const loginPath = isAdmin ? "/admin/login" : "/user/login";
        // 只在非登录页时跳转，避免循环
        if (!window.location.pathname.endsWith("/login")) {
          window.location.href = loginPath;
        }
      }
      throw new Error("UNAUTHORIZED");
    }
    throw new Error(`请求失败: ${res.status}`);
  }
  const json = await res.json();
  if (json.code !== 0) {
    throw new Error(json.message || "请求失败");
  }
  return json.data;
}

// ─── 默认 SWR 配置 ───
const defaultConfig: SWRConfiguration = {
  revalidateOnFocus: false,       // 窗口聚焦不自动刷新（避免频繁请求）
  revalidateOnReconnect: true,    // 网络恢复时刷新
  dedupingInterval: 5000,         // 5 秒内相同请求自动去重
  errorRetryCount: 2,             // 错误最多重试 2 次
  errorRetryInterval: 3000,       // 重试间隔 3 秒
  keepPreviousData: true,         // 参数变化时保留旧数据（避免闪烁）
};

// 在 SWR 自己的配置上多挂一个 requestTimeoutMs，供个别慢接口单独放宽。
// 它不是 SWR 的选项，传下去之前要摘掉，否则原样进 useSWR（无害但容易误导）。
export type ApiConfig = SWRConfiguration & { requestTimeoutMs?: number };

function splitConfig(config?: ApiConfig): { timeoutMs: number; swrConfig: SWRConfiguration } {
  const { requestTimeoutMs, ...swrConfig } = config ?? {};
  return { timeoutMs: requestTimeoutMs ?? DEFAULT_TIMEOUT_MS, swrConfig };
}

// ─── 通用数据请求 Hook ───
export function useApi<T = unknown>(
  url: string | null,
  config?: ApiConfig
) {
  const { timeoutMs, swrConfig } = splitConfig(config);
  return useSWR<T>(url, (k: string) => fetcher<T>(k, timeoutMs), { ...defaultConfig, ...swrConfig });
}

// ─── 带参数的请求（自动序列化查询参数） ───
export function useApiWithParams<T = unknown>(
  baseUrl: string | null,
  params?: Record<string, string | number | boolean | undefined>,
  config?: ApiConfig
) {
  let url = baseUrl;
  if (baseUrl && params) {
    const searchParams = new URLSearchParams();
    Object.entries(params).forEach(([key, value]) => {
      if (value !== undefined && value !== "") {
        searchParams.set(key, String(value));
      }
    });
    const qs = searchParams.toString();
    url = qs ? `${baseUrl}?${qs}` : baseUrl;
  }
  const { timeoutMs, swrConfig } = splitConfig(config);
  return useSWR<T>(url, (k: string) => fetcher<T>(k, timeoutMs), { ...defaultConfig, ...swrConfig });
}

// ─── 长缓存请求（适合不常变化的数据，如 MCC 列表、平台连接等） ───
export function useStaleApi<T = unknown>(
  url: string | null,
  config?: ApiConfig
) {
  const { timeoutMs, swrConfig } = splitConfig(config);
  return useSWR<T>(url, (k: string) => fetcher<T>(k, timeoutMs), {
    ...defaultConfig,
    dedupingInterval: 30000,        // 30 秒去重
    revalidateIfStale: false,       // 有缓存就不自动刷新
    revalidateOnMount: undefined,   // 首次挂载才请求
    ...swrConfig,
  });
}

// ─── 手动触发全局刷新 ───
export function refreshApi(keyOrFilter: string | RegExp) {
  if (typeof keyOrFilter === "string") {
    globalMutate(keyOrFilter);
  } else {
    // 正则匹配刷新多个 key
    globalMutate(
      (key) => typeof key === "string" && keyOrFilter.test(key),
      undefined,
      { revalidate: true }
    );
  }
}

// ─── POST/PUT/DELETE 操作后自动刷新相关缓存 ───
export async function mutateApi<T = unknown>(
  url: string,
  options: { method: string; body?: unknown; headers?: Record<string, string> },
  revalidateKeys?: (string | RegExp)[]
): Promise<{ code: number; message: string; data: T }> {
  const res = await fetch(url, {
    ...options,
    headers: { "Content-Type": "application/json", ...options.headers },
    body: options.body ? JSON.stringify(options.body) : undefined,
  });

  const json = await res.json();

  // 操作成功后刷新相关缓存
  if (json.code === 0 && revalidateKeys) {
    revalidateKeys.forEach((key) => refreshApi(key));
  }

  return json;
}

export { globalMutate };
