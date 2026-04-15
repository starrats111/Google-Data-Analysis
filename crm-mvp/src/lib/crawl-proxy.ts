/**
 * 国家级爬取代理支持
 *
 * 代理模板格式（管理台配置）：
 *   host:port:username_with_**:password
 *   例：sp.ipipbright.net:1000:bru30036_area-**_life-3_session-SN9MwnEwoy:e3lth6
 *   其中 ** 会被替换为实际国家代码（US / GB / AU 等）
 *
 * 底层走 SOCKS5 协议（socks-proxy-agent），Node.js https.request 发起实际请求。
 */

import * as https from "https";
import * as http from "http";

/** 从 DB 系统配置读取模板，替换国家代码，返回 SOCKS5 URL；未配置返回 null */
export async function getProxyUrlForCountry(country: string): Promise<string | null> {
  if (!country) return null;

  try {
    // 优先从 DB 读取（管理台可配置），兜底读 env var
    const { getCrawlProxyTemplate } = await import("@/lib/system-config");
    const template = await getCrawlProxyTemplate();

    if (template) {
      return buildSocks5Url(template, country);
    }
  } catch {
    // DB 不可用时走 env 兜底
  }

  // env 兜底：CRAWL_PROXY_US / CRAWL_PROXY_URL
  const envKey = `CRAWL_PROXY_${country.trim().toUpperCase()}`;
  const envVal = process.env[envKey] || process.env.CRAWL_PROXY_URL || null;
  return envVal;
}

/**
 * 将 host:port:username_with_**:password 模板 + 国家代码
 * 组装为 socks5://username:password@host:port
 */
export function buildSocks5Url(template: string, country: string): string {
  const parts = template.split(":");
  if (parts.length < 4) throw new Error(`代理模板格式错误，应为 host:port:username:password，实际: ${template}`);

  const host     = parts[0].trim();
  const port     = parts[1].trim();
  // username 可能含有 ':' 被拆分了（理论上不应该，但保险处理）
  const password = parts[parts.length - 1].trim();
  const username = parts.slice(2, parts.length - 1).join(":").replace(/\*\*/g, country.toUpperCase().trim());

  return `socks5://${encodeURIComponent(username)}:${encodeURIComponent(password)}@${host}:${port}`;
}

interface ProxyFetchResponse {
  status: number;
  url: string;
  ok: boolean;
  text(): Promise<string>;
  headers: Record<string, string | string[]>;
}

/**
 * 通过 SOCKS5/HTTP 代理发起请求（支持自动跟随重定向，最多 8 次）
 * 使用 socks-proxy-agent + Node.js 原生 https.request，无需 undici。
 */
export async function fetchViaProxy(
  url: string,
  options: {
    method?: string;
    headers?: Record<string, string>;
    signal?: AbortSignal;
  },
  proxyUrl: string,
  maxRedirects = 8,
): Promise<ProxyFetchResponse> {
  // 动态加载代理 agent（SOCKS5 用 socks-proxy-agent，HTTP 用 https-proxy-agent）
  let agent: unknown;
  if (proxyUrl.startsWith("socks")) {
    const { SocksProxyAgent } = await import("socks-proxy-agent");
    agent = new SocksProxyAgent(proxyUrl);
  } else {
    const { HttpsProxyAgent } = await import("https-proxy-agent");
    agent = new HttpsProxyAgent(proxyUrl);
  }

  const doRequest = (targetUrl: string, redirectCount: number): Promise<ProxyFetchResponse> => {
    return new Promise((resolve, reject) => {
      if (options.signal?.aborted) return reject(new Error("Aborted"));

      let parsed: URL;
      try { parsed = new URL(targetUrl); } catch (e) { return reject(e); }

      const isHttps = parsed.protocol === "https:";
      const reqOptions = {
        hostname: parsed.hostname,
        port: parsed.port ? parseInt(parsed.port) : (isHttps ? 443 : 80),
        path: parsed.pathname + parsed.search,
        method: options.method || "GET",
        headers: {
          "Accept": "text/html,application/xhtml+xml,*/*;q=0.9",
          "Accept-Encoding": "identity",
          ...(options.headers || {}),
        } as Record<string, string>,
        agent,
        timeout: 18000,
      };

      const mod = isHttps ? https : http;
      const req = (mod as typeof https).request(reqOptions as Parameters<typeof https.request>[0], (res) => {
        const status = res.statusCode || 0;
        const location = res.headers["location"];

        if ([301, 302, 303, 307, 308].includes(status) && location) {
          if (redirectCount >= maxRedirects) return reject(new Error(`Too many redirects`));
          res.resume();
          const nextUrl = new URL(String(location), targetUrl).toString();
          doRequest(nextUrl, redirectCount + 1).then(resolve).catch(reject);
          return;
        }

        const chunks: Buffer[] = [];
        res.on("data", (chunk: Buffer) => chunks.push(chunk));
        res.on("end", () => {
          const body = Buffer.concat(chunks).toString("utf8");
          resolve({
            status,
            url: targetUrl,
            ok: status >= 200 && status < 400,
            text: () => Promise.resolve(body),
            headers: res.headers as Record<string, string | string[]>,
          });
        });
        res.on("error", reject);
      });

      req.on("error", reject);
      req.on("timeout", () => { req.destroy(); reject(new Error("Proxy request timeout")); });
      if (options.signal) {
        const onAbort = () => { req.destroy(); reject(new Error("Aborted")); };
        options.signal.addEventListener("abort", onAbort, { once: true });
      }
      req.end();
    });
  };

  return doRequest(url, 0);
}
