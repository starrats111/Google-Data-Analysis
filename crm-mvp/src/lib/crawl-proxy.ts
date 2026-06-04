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
 * 获取 HTTP 代理 URL（专供 Puppeteer/Chrome 使用）。
 * Chrome 不支持 SOCKS5 代理认证，必须使用 HTTP/HTTPS 代理并配合 page.authenticate()。
 * 优先读 crawl_proxy_http_template；若未配置则返回 null（调用方应降级到直连）。
 */
export async function getHttpProxyUrlForCountry(country: string): Promise<string | null> {
  if (!country) return null;

  try {
    const { getCrawlHttpProxyTemplate } = await import("@/lib/system-config");
    const template = await getCrawlHttpProxyTemplate();
    if (template) {
      return buildSocks5Url(template, country); // buildSocks5Url 支持 http:// 前缀
    }
  } catch {
    // 忽略
  }

  // env 兜底：CRAWL_PROXY_HTTP_US / CRAWL_PROXY_HTTP_URL
  const envKey = `CRAWL_PROXY_HTTP_${country.trim().toUpperCase()}`;
  return process.env[envKey] || process.env.CRAWL_PROXY_HTTP_URL || null;
}

/**
 * 将代理模板 + 国家代码组装为代理 URL。
 *
 * 模板格式：[protocol://]host:port:username_with_**:password
 *   - 可在模板头部显式指定协议，如 "http://host:port:user:pass" 或 "socks5://host:port:user:pass"
 *   - 无协议前缀时默认 socks5://（适用于 cliproxy / ipipbright 等 SOCKS5 供应商）
 *   - username 中的 ** 会被替换为国家代码（US / GB / AU 等）
 *   - C-150：改用 cliproxy 住宅代理（rotating gateway，每次连接自动换出口 IP），
 *     不再需要 sid 轮换逻辑，故移除 sid- 随机替换。
 */
export function buildSocks5Url(template: string, country: string): string {
  // 提取可选的协议前缀（http:// / https:// / socks5://）
  let proto = "socks5";
  let rest = template.trim();
  const protoMatch = rest.match(/^(https?|socks5):\/\//i);
  if (protoMatch) {
    proto = protoMatch[1].toLowerCase();
    rest = rest.slice(protoMatch[0].length);
  }

  const parts = rest.split(":");
  if (parts.length < 4) throw new Error(`代理模板格式错误，应为 [proto://]host:port:username:password，实际: ${template}`);

  const host     = parts[0].trim();
  const port     = parts[1].trim();
  const password = parts[parts.length - 1].trim();
  // 仅替换国家代码（**）；C-150：cliproxy 住宅代理为 rotating gateway，无需 sid 轮换
  const username = parts.slice(2, parts.length - 1).join(":")
    .replace(/\*\*/g, country.toUpperCase().trim());

  return `${proto}://${encodeURIComponent(username)}:${encodeURIComponent(password)}@${host}:${port}`;
}

interface ProxyFetchResponse {
  status: number;
  url: string;
  ok: boolean;
  text(): Promise<string>;
  buffer(): Promise<Buffer>;
  headers: Record<string, string | string[]>;
}

/**
 * 探测代理实际出口 IP 与所属国家。
 *
 * 通过同一代理访问 ipinfo.io/json（免认证，response 含 ISO 国家码 `country`）。
 * 失败/超时直接抛错；成功返回 `{ip, country}`。
 *
 * 用途：sid 抽到错国出口时（如 region-ES 实际出在 NL）能识别并换 sid 重试。
 */
async function checkProxyEgress(proxyUrl: string, timeoutMs = 5000): Promise<{ ip: string; country: string }> {
  const ctrl = new AbortController();
  const tm = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const resp = await fetchViaProxy(
      "https://ipinfo.io/json",
      { signal: ctrl.signal },
      proxyUrl,
      3,
    );
    if (!resp.ok) throw new Error(`ipinfo HTTP ${resp.status}`);
    const text = await resp.text();
    const json = JSON.parse(text) as { ip?: string; country?: string };
    if (!json.ip || !json.country) throw new Error("ipinfo 缺少 ip/country 字段");
    return { ip: json.ip, country: json.country.toUpperCase() };
  } finally {
    clearTimeout(tm);
  }
}

/**
 * 获取经过出口国校验的 HTTP 代理 URL（供 Puppeteer 使用）。
 *
 * 流程：
 *   1. 调 getHttpProxyUrlForCountry(country) 拿原始 proxyUrl（含按国家模板替换 + 随机 sid）
 *   2. 通过 proxyUrl 调 ipinfo.io 探活，校验出口 country 是否与目标一致
 *   3. 不一致或探活失败 → 重新调一次（buildSocks5Url 内部会重新生成 sid）→ 重试
 *   4. maxRetries 次都失败 → 返回 null，让上层降级到直连（无代理）
 *
 * 校验通过的 proxyUrl 才返回，避免后续 puppeteer 抓取被错国出口 IP 浪费 100s+。
 */
export async function ensureCountryEgressHttpProxy(
  country: string,
  options: { maxRetries?: number; checkTimeoutMs?: number } = {},
): Promise<string | null> {
  if (!country) return null;
  const maxRetries = options.maxRetries ?? 3;
  const checkTimeoutMs = options.checkTimeoutMs ?? 5000;
  const targetCountry = country.toUpperCase().trim();

  let lastProxyUrl: string | null = null;
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    const proxyUrl = await getHttpProxyUrlForCountry(country).catch(() => null);
    if (!proxyUrl) {
      console.warn(`[CrawlProxy] getHttpProxyUrlForCountry(${country}) 返回 null，放弃代理`);
      return null;
    }
    lastProxyUrl = proxyUrl;
    try {
      const egress = await checkProxyEgress(proxyUrl, checkTimeoutMs);
      if (egress.country === targetCountry) {
        console.log(`[CrawlProxy] 代理出口校验通过 (尝试${attempt}/${maxRetries}): country=${egress.country} ip=${egress.ip}`);
        return proxyUrl;
      }
      console.warn(`[CrawlProxy] 代理出口国不符 (尝试${attempt}/${maxRetries}): 期望=${targetCountry} 实际=${egress.country} ip=${egress.ip}，换 sid 重试`);
    } catch (err) {
      console.warn(`[CrawlProxy] 代理探活失败 (尝试${attempt}/${maxRetries}): ${err instanceof Error ? err.message : err}，换 sid 重试`);
    }
  }
  console.warn(`[CrawlProxy] 代理出口校验 ${maxRetries} 次均不符 ${targetCountry}，降级处理`);
  // 校验失败：返回 null 让上层降级直连（直连虽然出口在腾讯云 CN，但很多站点接受）；
  // 经验数据：直连拿 4000+ 字 vs 错国代理拿 0 字，直连胜出
  return null;
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
          const rawBuf = Buffer.concat(chunks);
          resolve({
            status,
            url: targetUrl,
            ok: status >= 200 && status < 400,
            text: () => Promise.resolve(rawBuf.toString("utf8")),
            buffer: () => Promise.resolve(rawBuf),
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
