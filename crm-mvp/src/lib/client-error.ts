// D-060：前端网络层错误归一化。
// 浏览器在连接被中断（部署重启掐断在途请求 / SSE、网络抖动、Cloudflare 偶发断连、
// QUIC 协议错误等）时，fetch 会抛出 `TypeError: Failed to fetch`（Chrome）、
// `NetworkError when attempting to fetch resource`（Firefox）、`Load failed`（Safari）等
// 浏览器层英文错误。直接把 err.message 弹给员工既看不懂、也会误以为是业务 Bug。
// 统一在此识别"网络层错误"与"超时中止"，转成友好中文，业务错误则保留原始 message。

const NETWORK_ERROR_SIGNALS = [
  "failed to fetch",
  "networkerror",
  "network error",
  "load failed",
  "connection closed",
  "err_connection",
  "err_network",
  "err_quic",
  "err_timed_out",
  "err_internet_disconnected",
  "the network connection was lost",
  "fetch failed",
];

/** 是否为浏览器网络层（连接级）错误，而非业务返回的错误 */
export function isNetworkLayerError(err: unknown): boolean {
  if (err instanceof DOMException && err.name === "AbortError") return false;
  const raw = err instanceof Error ? err.message : typeof err === "string" ? err : "";
  const msg = raw.toLowerCase();
  if (!msg) return false;
  if (err instanceof TypeError && msg.includes("fetch")) return true;
  return NETWORK_ERROR_SIGNALS.some((s) => msg.includes(s));
}

export interface DescribeErrorOptions {
  /** AbortError（请求被中止/超时）时的提示，默认"请求超时，请稍后重试" */
  abortMessage?: string;
  /** 网络层错误时的提示，默认"网络连接中断，请检查网络后重试" */
  networkMessage?: string;
}

/**
 * 把任意 catch 到的错误转成可直接展示给员工的中文文案。
 *  - AbortError（超时/中止）→ opts.abortMessage（默认超时提示）
 *  - 网络层错误（连接中断/QUIC/断连）→ opts.networkMessage（默认网络中断提示）
 *  - 业务错误（带 message）→ 保留原始 message
 *  - 其它 → fallback
 */
export function describeClientError(
  err: unknown,
  fallback: string,
  opts: DescribeErrorOptions = {},
): string {
  if (err instanceof DOMException && err.name === "AbortError") {
    return opts.abortMessage ?? "请求超时，请稍后重试";
  }
  if (isNetworkLayerError(err)) {
    return opts.networkMessage ?? "网络连接中断，请检查网络后重试";
  }
  const msg = err instanceof Error ? err.message : typeof err === "string" ? err : "";
  return msg || fallback;
}
