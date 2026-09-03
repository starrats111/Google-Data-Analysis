import http from "node:http";
import https from "node:https";
import tls from "node:tls";
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
 *
 * 第二类同病（2026-09-03，D-311）：**证书链不完整**。真实案例 ncsf.org——
 * 服务器只发叶子证书，不发 GoDaddy G2 中间证书。浏览器会按 AIA 自己去补中间证书
 * （或命中缓存）照常打开，Node/curl 不补，直接 `unable to verify the first certificate`，
 * undici 又把它包成一句没信息量的 `fetch failed`。表现与上面一模一样：
 * 站点在浏览器里好好的，我们判它「链接无效」并劝用户删掉。
 *
 * 对策同样是「只放宽这一处，别的照旧」：识别出「缺中间证书」后重放一次，
 * 关掉链校验但**自己把叶子证书重新验一遍**（有效期 + 域名匹配）。
 * 过期、域名不符、自签名仍然判失败——那几种浏览器同样会拦，放行才是错的。
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

/** 只认「链不完整/签发者未知」这一种。CERT_HAS_EXPIRED、ALTNAME_INVALID、
 *  SELF_SIGNED_CERT 之类不在此列——浏览器也拦，我们跟着拦。 */
const TLS_CHAIN_SIGNALS = [
  "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
  "unable to verify the first certificate",
  "unable to get local issuer certificate",
  "unable to get issuer certificate",
];

const MAX_BODY_BYTES = 3 * 1024 * 1024;
const MAX_REDIRECTS = 10;

/** 沿 cause 链逐层取 `message + code`，供各类错误识别复用 */
function errorChain(err: unknown): string[] {
  const out: string[] = [];
  let cur: unknown = err;
  for (let i = 0; i < 5 && cur; i++) {
    out.push(cur instanceof Error
      ? `${cur.message} ${(cur as NodeJS.ErrnoException).code ?? ""}`
      : String(cur));
    cur = (cur as { cause?: unknown }).cause;
  }
  return out;
}

/** 判断异常是否为「响应头/分帧不合规」导致的解析失败（而非网络不通、超时、TLS 失败） */
export function isHttpParseError(err: unknown): boolean {
  return errorChain(err).some((msg) => PARSE_ERROR_SIGNALS.some((s) => msg.includes(s)));
}

/** 判断异常是否为「服务器没发中间证书」——证书本身可能完全有效，浏览器能正常打开 */
export function isTlsChainIncompleteError(err: unknown): boolean {
  return errorChain(err).some((msg) => TLS_CHAIN_SIGNALS.some((s) => msg.includes(s)));
}

/**
 * 把 undici 那句没信息量的 `fetch failed` 展开成 cause 链里真正的原因。
 * 排查「链接为什么校验不过」时，`fetch failed` 等于什么都没说——
 * 真正的话（证书链不完整 / ECONNREFUSED / ENOTFOUND）都在 cause 里。
 */
export function describeFetchFailure(err: unknown): string {
  const chain = errorChain(err).map((m) => m.trim()).filter(Boolean);
  // 最里层最具体；"fetch failed" 只是外壳，有更里层就丢掉
  const meaningful = chain.filter((m) => m !== "fetch failed");
  return (meaningful.length ? meaningful[meaningful.length - 1] : chain[0]) || "未知错误";
}

/**
 * 关掉链校验后自己补验叶子证书：有效期内 + 域名匹配。
 * 返回 null 表示证书除了「缺中间证书」以外没毛病，可以放行。
 */
export function leafCertDefect(socket: unknown, hostname: string): string | null {
  const tlsSocket = socket as tls.TLSSocket | null;
  if (!tlsSocket || typeof tlsSocket.getPeerCertificate !== "function") return "拿不到对端证书";
  const cert = tlsSocket.getPeerCertificate(false);
  if (!cert || Object.keys(cert).length === 0) return "对端未提供证书";

  const now = Date.now();
  const from = Date.parse(cert.valid_from);
  const to = Date.parse(cert.valid_to);
  if (Number.isFinite(from) && now < from) return `证书尚未生效（${cert.valid_from}）`;
  if (Number.isFinite(to) && now > to) return `证书已过期（${cert.valid_to}）`;

  const idErr = tls.checkServerIdentity(hostname, cert);
  if (idErr) return `证书域名不匹配（${idErr.message.slice(0, 60)}）`;
  return null;
}

/** 降级重放时放宽了什么——两项互不牵连，识别到哪种就只放宽哪种 */
interface RelaxOptions {
  /** 放宽 HTTP 分帧解析（裸 LF 折行等） */
  insecureHTTPParser?: boolean;
  /** 放宽证书**链**校验，叶子证书仍由 leafCertDefect 自验 */
  acceptIncompleteChain?: boolean;
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
  relax: RelaxOptions,
): Promise<LenientResult> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new Error("The operation was aborted"));

    let parsed: URL;
    try { parsed = new URL(url); } catch (e) { return reject(e); }
    const isHttps = parsed.protocol !== "http:";
    const mod = parsed.protocol === "http:" ? http : https;

    const req = mod.request(
      {
        protocol: parsed.protocol,
        hostname: parsed.hostname,
        port: parsed.port || (parsed.protocol === "http:" ? 80 : 443),
        path: `${parsed.pathname}${parsed.search}`,
        method,
        headers: { ...headers, Host: parsed.host },
        insecureHTTPParser: relax.insecureHTTPParser === true,
        ...(relax.acceptIncompleteChain && isHttps ? { rejectUnauthorized: false } : {}),
        timeout: timeoutMs,
      },
      (res) => {
        // 链校验关掉了，叶子证书得自己验——过期/域名不符照样判失败
        if (relax.acceptIncompleteChain && isHttps) {
          const defect = leafCertDefect(res.socket, parsed.hostname);
          if (defect) {
            res.destroy();
            req.destroy();
            return reject(new Error(defect));
          }
        }
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

async function lenientFetch(url: string, init: RequestInit | undefined, relax: RelaxOptions): Promise<Response> {
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
    result = await requestOnce(current, method, headers, signal, 15000, relax);
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
 * 仅当「响应头不合规」或「服务器漏发中间证书」导致原生 fetch 抛错时，降级重放一次。
 * 两种降级各自只放宽自己那一处，不互相牵连。
 */
export async function fetchCompat(url: string, init?: RequestInit): Promise<Response> {
  try {
    return await fetch(url, init);
  } catch (err) {
    if (init?.signal?.aborted) throw err;
    if (isHttpParseError(err)) {
      console.warn(`[LenientFetch] 响应头不合规，降级 insecureHTTPParser 重试: ${url.slice(0, 100)}`);
      return await lenientFetch(url, init, { insecureHTTPParser: true });
    }
    if (isTlsChainIncompleteError(err)) {
      console.warn(`[LenientFetch] 服务器漏发中间证书，改为自验叶子证书后重试: ${url.slice(0, 100)}`);
      return await lenientFetch(url, init, { acceptIncompleteChain: true });
    }
    throw err;
  }
}
