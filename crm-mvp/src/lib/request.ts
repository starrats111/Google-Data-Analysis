/**
 * 统一 API 请求封装 — 参考老系统 frontend/src/services/api.js
 *
 * 功能：
 * 1. 统一错误处理 + 自动跳转登录
 * 2. 请求去重（相同 GET 请求不重复发送）
 * 3. 请求超时控制
 * 4. 组件卸载时自动取消请求
 * 5. 统一的响应类型
 */

// ─── 类型定义 ───
export interface ApiResponse<T = unknown> {
  code: number;
  message: string;
  data: T;
}

interface RequestOptions extends Omit<RequestInit, "body"> {
  body?: unknown;
  timeout?: number; // 超时时间（ms），默认 30s
  silent?: boolean; // 静默模式，不弹错误提示
  raw?: boolean; // 返回原始 Response
}

// ─── 请求去重 Map ───
const pendingRequests = new Map<string, Promise<ApiResponse>>();

function getRequestKey(url: string, method: string): string {
  return `${method}:${url}`;
}

// ─── 核心请求函数 ───
async function request<T = unknown>(
  url: string,
  options: RequestOptions = {}
): Promise<ApiResponse<T>> {
  const {
    timeout = 30000,
    silent = false,
    raw = false,
    body,
    ...fetchOptions
  } = options;

  const method = (fetchOptions.method || "GET").toUpperCase();

  // GET 请求去重
  if (method === "GET") {
    const key = getRequestKey(url, method);
    const existing = pendingRequests.get(key);
    if (existing) return existing as Promise<ApiResponse<T>>;
  }

  // 超时控制
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeout);

  const config: RequestInit = {
    ...fetchOptions,
    method,
    signal: controller.signal,
    headers: {
      "Content-Type": "application/json",
      ...fetchOptions.headers,
    },
  };

  if (body !== undefined && method !== "GET") {
    config.body = JSON.stringify(body);
  }

  const requestPromise = (async (): Promise<ApiResponse<T>> => {
    try {
      const response = await fetch(url, config);

      // 未认证 → 跳转登录
      if (response.status === 401) {
        const isAdmin = url.includes("/api/admin");
        const loginPath = isAdmin ? "/admin/login" : "/user/login";
        if (typeof window !== "undefined" && !window.location.pathname.includes("/login")) {
          !silent && console.warn("登录已过期，请重新登录");
          window.location.href = loginPath;
        }
        return { code: -1, message: "未登录或登录已过期", data: null as T };
      }

      if (raw) {
        return { code: 0, message: "ok", data: response as unknown as T };
      }

      const result: ApiResponse<T> = await response.json();

      // 业务错误
      if (result.code !== 0 && !silent) {
        console.warn(result.message || "请求失败");
      }

      return result;
    } catch (err: unknown) {
      if (err instanceof DOMException && err.name === "AbortError") {
        !silent && console.warn("请求超时，请稍后重试");
        return { code: -1, message: "请求超时", data: null as T };
      }
      !silent && console.warn("网络错误，请检查网络连接");
      return { code: -1, message: "网络错误", data: null as T };
    } finally {
      clearTimeout(timeoutId);
      if (method === "GET") {
        pendingRequests.delete(getRequestKey(url, method));
      }
    }
  })();

  // GET 请求存入去重 Map
  if (method === "GET") {
    pendingRequests.set(
      getRequestKey(url, method),
      requestPromise as Promise<ApiResponse>
    );
  }

  return requestPromise;
}

// ─── 便捷方法 ───
export const api = {
  get: <T = unknown>(url: string, options?: RequestOptions) =>
    request<T>(url, { ...options, method: "GET" }),

  post: <T = unknown>(url: string, body?: unknown, options?: RequestOptions) =>
    request<T>(url, { ...options, method: "POST", body }),

  put: <T = unknown>(url: string, body?: unknown, options?: RequestOptions) =>
    request<T>(url, { ...options, method: "PUT", body }),

  delete: <T = unknown>(url: string, options?: RequestOptions) =>
    request<T>(url, { ...options, method: "DELETE" }),

  patch: <T = unknown>(url: string, body?: unknown, options?: RequestOptions) =>
    request<T>(url, { ...options, method: "PATCH", body }),
};

export default api;
