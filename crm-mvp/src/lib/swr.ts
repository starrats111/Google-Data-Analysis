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

// ─── 全局 fetcher ───
async function fetcher<T>(url: string): Promise<T> {
  const res = await fetch(url);
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

// ─── 通用数据请求 Hook ───
export function useApi<T = unknown>(
  url: string | null,
  config?: SWRConfiguration
) {
  return useSWR<T>(url, fetcher, { ...defaultConfig, ...config });
}

// ─── 带参数的请求（自动序列化查询参数） ───
export function useApiWithParams<T = unknown>(
  baseUrl: string | null,
  params?: Record<string, string | number | boolean | undefined>,
  config?: SWRConfiguration
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
  return useSWR<T>(url, fetcher, { ...defaultConfig, ...config });
}

// ─── 长缓存请求（适合不常变化的数据，如 MCC 列表、平台连接等） ───
export function useStaleApi<T = unknown>(
  url: string | null,
  config?: SWRConfiguration
) {
  return useSWR<T>(url, fetcher, {
    ...defaultConfig,
    dedupingInterval: 30000,        // 30 秒去重
    revalidateIfStale: false,       // 有缓存就不自动刷新
    revalidateOnMount: undefined,   // 首次挂载才请求
    ...config,
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
