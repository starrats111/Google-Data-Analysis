import http from "node:http";
import https from "node:https";
import zlib from "node:zlib";

/**
 * 宽容 HTTP 解析的 fetch 包装。
 *
 * 背景（2026-08-29）：Node 的 undici fetch 用 llhttp 严格模式解析响应头，
 * 遇到不合规的响应头会直接抛 `TypeError: fetch failed`，整个响应拿不到。
 * 真实案例 promodirect.com：CSP 头用**裸 LF + 空格**折行（9 处），
 * curl 和浏览器都容错放行，undici 拒收 —— 于是商家网站在浏览器里打得开，
 * 我们的链接校验却报「连接打不开」，把好链接标成无效链接。
 *
 * 策略：正常站点走原生 fetch，行为完全不变；**只有**在识别出协议解析错误时，
 * 才降级到 node:https 的 insecureHTTPParser 重放一次。
 * 降级只放宽 HTTP 分帧解析，TLS 证书校验保持不变。
 */

const PARSE_ERROR_SIGNALS = [
  "HPE_",
  "does not match the HTTP/1.1 protocol",
  "Missing expected CR",
  "Expected HTTP/",
  "Invalid header value char",
  "Invalid header token",
  "Parse Error",
];

const MAX_BODY_BYTES = 3 * 1024 * 1024;
const MAX_REDIRECTS = 10;

/** 判断异常是否为「响应头/分帧不合规」导致的解析失败（而非网络不通、超时、TLS 失败） */
export function isHttpParseError(err: unknown): boolean {
  let cur: unknown = err;
  for (let i = 0; i < 5 && cur; i++) {
    const msg = cur instanceof Error
      ? `${cur.message} ${(cur as NodeJS.ErrnoException).code ?? ""}`
      : String(cur);
    if (PARSE_ERROR_SIGNALS.some((s) => msg.includes(s))) return true;
    cur = (cur as { cause?: unknown }).cause;
  }
  return false;
}

function decodeBody(buf: Buffer, encoding: string | undefined): Buffer {
  if (!buf.length) return buf;
  const enc = (encoding || "").toLowerCase().trim();
  try {
    if (enc === "gzip" || enc === "x-gzip") return zlib.gunzipSync(buf);
    if (enc === "deflate") return zlib.inflateSync(buf);
    if (enc === "br") return zlib.brotliDecompressSync(buf);
  } catch {
    // 解压失败（截断的压缩体等）→ 退回原始字节，交给上层按文本尽力解析
  }
  return buf;
}

type LenientResult = { status: number; headers: http.IncomingHttpHeaders; body: Buffer; finalUrl: string };

function requestOnce(
  url: string,
  method: string,
  headers: Record<string, string>,
  signal: AbortSignal | undefined,
  timeoutMs: number,
): Promise<LenientResult> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new Error("The operation was aborted"));

    let parsed: URL;
    try { parsed = new URL(url); } catch (e) { return reject(e); }
    const mod = parsed.protocol === "http:" ? http : https;

    const req = mod.request(
      {
        protocol: parsed.protocol,
        hostname: parsed.hostname,
        port: parsed.port || (parsed.protocol === "http:" ? 80 : 443),
        path: `${parsed.pathname}${parsed.search}`,
        method,
        headers: { ...headers, Host: parsed.host },
        insecureHTTPParser: true,
        timeout: timeoutMs,
      },
      (res) => {
        const chunks: Buffer[] = [];
        let total = 0;
        res.on("data", (c: Buffer) => {
          total += c.length;
          if (total <= MAX_BODY_BYTES) chunks.push(c);
          else res.destroy();
        });
        res.on("end", () => {
          resolve({
            status: res.statusCode ?? 0,
            headers: res.headers,
            body: decodeBody(Buffer.concat(chunks), res.headers["content-encoding"]),
            finalUrl: url,
          });
        });
        res.on("error", reject);
      },
    );

    const onAbort = () => req.destroy(new Error("The operation was aborted"));
    signal?.addEventListener("abort", onAbort, { once: true });
    req.on("close", () => signal?.removeEventListener("abort", onAbort));
    req.on("error", reject);
    req.on("timeout", () => req.destroy(new Error("The operation was aborted")));
    req.end();
  });
}

async function lenientFetch(url: string, init: RequestInit | undefined): Promise<Response> {
  const method = (init?.method || "GET").toUpperCase();
  const signal = init?.signal ?? undefined;

  // 归一化调用方传入的 headers，并强制一个我们能解压的 Accept-Encoding
  const headers: Record<string, string> = {};
  new Headers(init?.headers as HeadersInit | undefined).forEach((v, k) => {
    if (k.toLowerCase() === "host") return;
    headers[k] = v;
  });
  headers["accept-encoding"] = "gzip, deflate, br";

  const follow = (init?.redirect ?? "follow") === "follow";
  let current = url;
  let result: LenientResult | null = null;

  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    result = await requestOnce(current, method, headers, signal, 15000);
    const loc = result.headers.location;
    if (!follow || !loc || result.status < 300 || result.status >= 400) break;
    try { current = new URL(loc, current).toString(); } catch { break; }
    result.finalUrl = current;
    if (hop === MAX_REDIRECTS) break;
  }

  if (!result) throw new Error("lenientFetch: 无响应");

  const outHeaders = new Headers();
  for (const [k, v] of Object.entries(result.headers)) {
    if (v === undefined) continue;
    // content-encoding/length 已在解压后失真，剔除避免下游误判
    if (k === "content-encoding" || k === "content-length") continue;
    for (const one of Array.isArray(v) ? v : [v]) {
      try { outHeaders.append(k, one); } catch { /* 跳过非法头，不影响主体 */ }
    }
  }

  const bodyless = method === "HEAD" || result.status === 204 || result.status === 304;
  const status = result.status >= 200 && result.status <= 599 ? result.status : 500;
  const res = new Response(bodyless ? null : new Uint8Array(result.body), { status, headers: outHeaders });
  // Response.url 是原型上的 getter，用自有属性遮蔽，让调用方 res.url 拿到真实最终地址
  Object.defineProperty(res, "url", { value: current, configurable: true });
  return res;
}

/**
 * fetch 的直接替代品：正常站点行为与原生 fetch 完全一致，
 * 仅当响应头不合规导致原生 fetch 抛错时，降级重放一次。
 */
export async function fetchCompat(url: string, init?: RequestInit): Promise<Response> {
  try {
    return await fetch(url, init);
  } catch (err) {
    if (!isHttpParseError(err)) throw err;
    if (init?.signal?.aborted) throw err;
    console.warn(`[LenientFetch] 响应头不合规，降级 insecureHTTPParser 重试: ${url.slice(0, 100)}`);
    return await lenientFetch(url, init);
  }
}
