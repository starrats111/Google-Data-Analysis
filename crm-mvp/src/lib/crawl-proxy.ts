/**
 * 国家级代理支持
 *
 * 通过环境变量配置各国代理 URL，爬虫使用目标国家 IP 发起请求，
 * 确保商户网站按地理位置返回正确 locale 的 URL 和内容。
 *
 * 配置示例（.env.local / 服务器环境变量）：
 *   CRAWL_PROXY_US=http://user:pass@us-proxy.example.com:8080
 *   CRAWL_PROXY_GB=http://user:pass@gb-proxy.example.com:8080
 *   CRAWL_PROXY_AU=http://user:pass@au-proxy.example.com:8080
 *   CRAWL_PROXY_URL=http://user:pass@default-proxy.example.com:8080  # 通用兜底
 */

import * as https from "https";
import * as http from "http";

/** 从环境变量获取指定国家的代理 URL，不存在返回 null */
export function getProxyUrlForCountry(country: string): string | null {
  if (!country) return null;
  const key = `CRAWL_PROXY_${country.trim().toUpperCase()}`;
  return process.env[key] || process.env.CRAWL_PROXY_URL || null;
}

interface ProxyFetchResponse {
  status: number;
  url: string;
  ok: boolean;
  text(): Promise<string>;
  headers: Record<string, string | string[]>;
}

/**
 * 通过代理发起 HTTP/HTTPS 请求（支持重定向跟随，最多 8 次）
 * 使用 https-proxy-agent + Node.js 原生 http/https 模块，兼容服务器环境。
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
  // 动态加载 https-proxy-agent（避免顶层 import 影响不需要代理的路径）
  const { HttpsProxyAgent } = await import("https-proxy-agent");
  const agent = new HttpsProxyAgent(proxyUrl);

  const doRequest = (
    targetUrl: string,
    redirectCount: number,
  ): Promise<ProxyFetchResponse> => {
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
        timeout: 15000,
      };

      const mod = isHttps ? https : http;
      const req = (mod as typeof https).request(reqOptions as Parameters<typeof https.request>[0], (res) => {
        const status = res.statusCode || 0;
        const location = res.headers["location"];

        // 跟随重定向
        if ([301, 302, 303, 307, 308].includes(status) && location) {
          if (redirectCount >= maxRedirects) {
            return reject(new Error(`Too many redirects (${maxRedirects})`));
          }
          res.resume(); // 释放 socket
          const nextUrl = new URL(location, targetUrl).toString();
          doRequest(nextUrl, redirectCount + 1).then(resolve).catch(reject);
          return;
        }

        const chunks: Buffer[] = [];
        res.on("data", (chunk: Buffer) => chunks.push(chunk));
        res.on("end", () => {
          const bodyStr = Buffer.concat(chunks).toString("utf8");
          resolve({
            status,
            url: targetUrl,
            ok: status >= 200 && status < 400,
            text: () => Promise.resolve(bodyStr),
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
