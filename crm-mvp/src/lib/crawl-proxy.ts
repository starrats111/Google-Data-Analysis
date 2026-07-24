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

/**
 * 取国家级 SOCKS5 代理 URL。
 *
 * ⚠️ 代理出口按用途隔离（2026-07-04）：
 *   - 换链接（补货/跟链/suffix，**传 userId**）：只走换链接供应商池(kyads_proxies=kookeey)，
 *     取不到即返回 null，**绝不兜底到 system_config 模板(arxlabs=AI 出口)**，避免两条线串代理。
 *   - AI 爬取/分类/素材等（**不传 userId**）：走 system_config 模板(crawl_proxy_template=arxlabs) → env。
 *
 * @param opts.exchange true=换链接路径（仅 kookeey，无 arxlabs 兜底）
 * @param opts.userId 换链接路径下用于选该用户分配的供应商；传 userId 亦隐含 exchange
 */
export async function getProxyUrlForCountry(
  country: string,
  opts: { userId?: bigint | null; exchange?: boolean } = {},
): Promise<string | null> {
  if (!country) return null;

  const isExchange = opts.exchange === true || (opts.userId != null && opts.userId > BigInt(0));

  // 1) 换链接代理供应商（动态导入避免与 proxy-provider 循环依赖）
  // 出口隔离补全（2026-07-13）：此前这一步**不分路径**先查供应商池——AI 爬虫（无 userId）也会
  // pickHealthyGlobal() 拿到 kookeey 代理并直接 return，管理台配的 crawl_proxy_template(arxlabs)
  // 形同虚设。后果：爬虫的每次代理复核/重试都在开 kookeey 粘性会话（5 分钟不释放），
  // 挤占换链接/刷点击的并发配额，是「Socks5 Authentication failed」的推手之一。
  // 7-04 的隔离只改了 HTTP(Puppeteer) 方向，这里把 SOCKS 方向对齐：仅换链接路径查供应商池。
  if (isExchange) {
    try {
      const { getProviderProxyUrl } = await import("@/lib/suffix-engine/proxy-provider");
      const providerUrl = await getProviderProxyUrl(country, { userId: opts.userId });
      if (providerUrl) return providerUrl;
    } catch {
      // 供应商不可用时落到下方 return null
    }
    // 换链接路径到此为止：宁可无代理（上层重试/降级），也不串用 AI 的 arxlabs 出口。
    return null;
  }

  try {
    // 2) 从 DB 读取模板（管理台可配置），兜底读 env var —— 仅 AI 路径
    const { getCrawlProxyTemplate } = await import("@/lib/system-config");
    const template = await getCrawlProxyTemplate();

    if (template) {
      return buildSocks5Url(template, country);
    }
  } catch {
    // DB 不可用时走 env 兜底
  }

  // 3) env 兜底：CRAWL_PROXY_US / CRAWL_PROXY_URL
  const envKey = `CRAWL_PROXY_${country.trim().toUpperCase()}`;
  const envVal = process.env[envKey] || process.env.CRAWL_PROXY_URL || null;
  return envVal;
}

/**
 * 获取 HTTP 代理 URL（专供 Puppeteer/Chrome 使用）。
 * Chrome 不支持 SOCKS5 代理认证，必须使用 HTTP/HTTPS 代理并配合 page.authenticate()。
 *
 * ⚠️ 出口隔离（2026-07-04）：
 *   - 换链接浏览器兜底（**传 userId**）：从换链接供应商池(kookeey，1000 端口 http)取，
 *     取不到即返回 null，**绝不读 crawl_proxy_http_template(arxlabs=AI 出口)**。
 *   - AI 路径（**不传 userId**）：读 crawl_proxy_http_template(arxlabs) → env。
 *
 * @param opts.exchange true=换链接路径（仅 kookeey http，无 arxlabs 兜底）
 * @param opts.userId 换链接路径下用于选该用户分配的供应商；传 userId 亦隐含 exchange
 */
export async function getHttpProxyUrlForCountry(
  country: string,
  opts: { userId?: bigint | null; exchange?: boolean } = {},
): Promise<string | null> {
  if (!country) return null;

  const isExchange = opts.exchange === true || (opts.userId != null && opts.userId > BigInt(0));

  // 换链接路径：走 kookeey 供应商池的 HTTP 代理（动态导入避免循环依赖），取不到即 null（不串 arxlabs）。
  if (isExchange) {
    try {
      const { getProviderHttpProxyUrl } = await import("@/lib/suffix-engine/proxy-provider");
      return await getProviderHttpProxyUrl(country, { userId: opts.userId });
    } catch {
      return null;
    }
  }

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

  // socks5 统一用 socks5h（远程 DNS）：让代理出口解析目标域名，避免本地 DNS 泄漏/解析到错区，
  // 也规避部分 EPROTO/解析失败。http/https 代理保持原协议。
  const outProto = proto === "socks5" ? "socks5h" : proto;
  return `${outProto}://${encodeURIComponent(username)}:${encodeURIComponent(password)}@${host}:${port}`;
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
/**
 * 业务国家码 → ISO 3166-1 alpha-2 归一化（出口校验比对用）。
 * 系列/商家侧习惯用 UK，而 ipinfo 等 IP 库返回 ISO 码 GB——不归一会导致
 * 「期望=UK 实际=GB」永远校验失败：每次取代理白烧 3 次探活流量后降级直连（CN 出口），
 * UK 系列因此系统性跟链失败（D-176 死链事故的组成部分）。
 * 注意与 toProxyCountryCode（ISO→供应商别名，GB→UK，组装代理用户名用）方向相反，两者并存不冲突。
 */
export function toIsoCountryCode(code: string): string {
  const upper = code.toUpperCase().trim();
  if (upper === "UK") return "GB";
  return upper;
}

export interface CountryEgressHttpProxyResult {
  proxyUrl: string;
  /** 出口校验时探到的出口 IP（egressVerified=false 时为 null）。调用方可直接复用，免对同一粘性会话重复探活。 */
  exitIp: string | null;
  /** true=ipinfo 出口国校验通过；false=探活反复超时、按模板国家未验证放行（仅 fallbackToUnverified 时出现） */
  egressVerified: boolean;
}

export async function ensureCountryEgressHttpProxyDetailed(
  country: string,
  options: {
    maxRetries?: number;
    checkTimeoutMs?: number;
    userId?: bigint | null;
    exchange?: boolean;
    /** 降耗（2026-07-24）：住宅代理访问 ipinfo 易超时，线上绝大多数校验失败是「探活超时」而非出口国真不符
     *  （模板锁国家、实测地理定向 100% 准确）。true 时若所有尝试均为超时/网络错（从未探到「出口国不符」的
     *  确定性结论），放行最后一个会话而不是丢弃——旧行为把好会话白白废弃（仍占上游 IP 5 分钟），还让上层
     *  报 proxy_unavailable 触发整条链路冷却重试，是流量白烧的放大器。出口国真不符时仍返回 null。 */
    fallbackToUnverified?: boolean;
  } = {},
): Promise<CountryEgressHttpProxyResult | null> {
  if (!country) return null;
  const maxRetries = options.maxRetries ?? 3;
  const checkTimeoutMs = options.checkTimeoutMs ?? 5000;
  const targetCountry = toIsoCountryCode(country);

  let lastProxyUrl: string | null = null;
  let lastFailure: "probe_error" | "mismatch" | null = null;
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    // exchange=换链接路径（kookeey http，每次新会话换出口 IP）；否则=AI 路径（arxlabs http 模板）
    const proxyUrl = await getHttpProxyUrlForCountry(country, { userId: options.userId, exchange: options.exchange }).catch(() => null);
    if (!proxyUrl) {
      console.warn(`[CrawlProxy] getHttpProxyUrlForCountry(${country}) 返回 null，放弃代理`);
      return null;
    }
    lastProxyUrl = proxyUrl;
    try {
      const egress = await checkProxyEgress(proxyUrl, checkTimeoutMs);
      if (egress.country === targetCountry) {
        console.log(`[CrawlProxy] 代理出口校验通过 (尝试${attempt}/${maxRetries}): country=${egress.country} ip=${egress.ip}`);
        return { proxyUrl, exitIp: egress.ip, egressVerified: true };
      }
      lastFailure = "mismatch";
      console.warn(`[CrawlProxy] 代理出口国不符 (尝试${attempt}/${maxRetries}): 期望=${targetCountry} 实际=${egress.country} ip=${egress.ip}，换 sid 重试`);
    } catch (err) {
      lastFailure = "probe_error";
      console.warn(`[CrawlProxy] 代理探活失败 (尝试${attempt}/${maxRetries}): ${err instanceof Error ? err.message : err}，换 sid 重试`);
    }
  }
  // 最后一次尝试仅是探活超时/网络错（没有「出口国不符」的确定性证据）→ 按模板国家未验证放行，
  // 保住会话避免白烧；真探到错国出口才彻底放弃。
  if (options.fallbackToUnverified && lastProxyUrl && lastFailure === "probe_error") {
    console.warn(`[CrawlProxy] ${targetCountry} 出口校验 ${maxRetries} 次均为探活超时（非出口国不符），按模板国家未验证放行，避免丢弃可用会话`);
    return { proxyUrl: lastProxyUrl, exitIp: null, egressVerified: false };
  }
  console.warn(`[CrawlProxy] 代理出口校验 ${maxRetries} 次均不符 ${targetCountry}，降级处理`);
  // 校验失败：返回 null 让上层降级直连（直连虽然出口在腾讯云 CN，但很多站点接受）；
  // 经验数据：直连拿 4000+ 字 vs 错国代理拿 0 字，直连胜出
  return null;
}

/** 兼容旧签名（AI 爬虫路径 crawl-pipeline 在用）：仅返回校验通过的 proxyUrl，行为与改造前完全一致。 */
export async function ensureCountryEgressHttpProxy(
  country: string,
  options: { maxRetries?: number; checkTimeoutMs?: number; userId?: bigint | null; exchange?: boolean } = {},
): Promise<string | null> {
  const res = await ensureCountryEgressHttpProxyDetailed(country, options);
  return res?.proxyUrl ?? null;
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
  // 2026-07-13：8 → 10，与 checkReachability/url-validator 统一（联盟链 9-10 跳时三套组件结论打架）
  maxRedirects = 10,
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

  // 全局并发会话名额：把同时在飞的代理会话压到安全线内，避免撞 kookeey 单子账号并发上限
  // （超限会被 kookeey 拒绝、表现为 Socks5 Authentication failed）。整个重定向链共用一个名额。
  const { withProxySlot } = await import("@/lib/suffix-engine/proxy-throttle");

  // 2026-07-13 资源护栏：
  //   ① 链级总超时——此前只有每跳 18s socket 超时，10 跳理论可拖 180s，整条链一直占着代理名额；
  //   ② body 上限 3MB——此前 chunks 无限 push，异常站返回 GB 级响应直接 OOM。
  //     调用方最多取 150KB HTML，3MB 截断无损业务；截断的压缩体不解压（保原始字节）。
  const CHAIN_DEADLINE_MS = 45_000;
  const MAX_BODY_BYTES = 3 * 1024 * 1024;
  const chainDeadline = Date.now() + CHAIN_DEADLINE_MS;

  const doRequest = (targetUrl: string, redirectCount: number, method: string): Promise<ProxyFetchResponse> => {
    return new Promise((resolve, reject) => {
      if (options.signal?.aborted) return reject(new Error("Aborted"));
      const remainingMs = chainDeadline - Date.now();
      if (remainingMs <= 0) return reject(new Error("Proxy redirect chain deadline exceeded"));

      let parsed: URL;
      try { parsed = new URL(targetUrl); } catch (e) { return reject(e); }

      const isHttps = parsed.protocol === "https:";
      // gzip 乱码病灶修复：本实现用原生 https.request，不会像 fetch 那样自动解压。
      // 调用方（crawler/url-validator 的 stealth 头）常带 Accept-Encoding: gzip, deflate, br，
      // 覆盖默认 identity 后服务器返回压缩体，rawBuf.toString("utf8") 得到二进制乱码——
      // 代理路径抓取/校验因此长期拿不到有效 HTML。对策：①请求头强制 identity（放在 spread 之后，
      // 调用方不可覆盖）；②仍收到压缩体（部分 CDN 无视 identity）时按 content-encoding 解压兜底。
      const mergedHeaders: Record<string, string> = {
        "Accept": "text/html,application/xhtml+xml,*/*;q=0.9",
        ...(options.headers || {}),
      };
      for (const k of Object.keys(mergedHeaders)) {
        if (k.toLowerCase() === "accept-encoding") delete mergedHeaders[k];
      }
      mergedHeaders["Accept-Encoding"] = "identity";
      const reqOptions = {
        hostname: parsed.hostname,
        port: parsed.port ? parseInt(parsed.port) : (isHttps ? 443 : 80),
        path: parsed.pathname + parsed.search,
        method,
        headers: mergedHeaders,
        agent,
        // 单跳 socket 超时不得超过链级剩余预算
        timeout: Math.min(18000, remainingMs),
      };

      const mod = isHttps ? https : http;
      const req = (mod as typeof https).request(reqOptions as unknown as Parameters<typeof https.request>[0], (res) => {
        const status = res.statusCode || 0;
        const location = res.headers["location"];

        if ([301, 302, 303, 307, 308].includes(status) && location) {
          if (redirectCount >= maxRedirects) return reject(new Error(`Too many redirects`));
          res.resume();
          const locRaw = Array.isArray(location) ? location[0] : location;
          const nextUrl = new URL(String(locRaw), targetUrl).toString();
          // 303（及历史惯例的 302+POST）后续跳一律转 GET，对齐浏览器/fetch 行为
          const nextMethod = status === 303 || (status === 302 && method !== "GET" && method !== "HEAD") ? "GET" : method;
          doRequest(nextUrl, redirectCount + 1, nextMethod).then(resolve).catch(reject);
          return;
        }

        const chunks: Buffer[] = [];
        let received = 0;
        let truncated = false;
        res.on("data", (chunk: Buffer) => {
          if (truncated) return;
          received += chunk.length;
          if (received > MAX_BODY_BYTES) {
            truncated = true;
            // 已超上限：保留已收字节，销毁连接防继续吸流量
            res.destroy();
            return;
          }
          chunks.push(chunk);
        });
        let settled = false;
        const finish = () => {
          if (settled) return;
          settled = true;
          let rawBuf = Buffer.concat(chunks);
          // 兜底解压：见上方 gzip 乱码病灶注释。截断的压缩体解压必失败，保原始字节。
          const enc = String(res.headers["content-encoding"] || "").toLowerCase();
          if (enc && rawBuf.length > 0 && !truncated) {
            try {
              const zlib = require("zlib") as typeof import("zlib");
              if (enc.includes("br")) rawBuf = zlib.brotliDecompressSync(rawBuf);
              else if (enc.includes("gzip")) rawBuf = zlib.gunzipSync(rawBuf);
              else if (enc.includes("deflate")) rawBuf = zlib.inflateSync(rawBuf);
            } catch {
              // 解压失败保留原始字节（可能本就未压缩）
            }
          }
          resolve({
            status,
            url: targetUrl,
            ok: status >= 200 && status < 400,
            // 2026-07-13（第五轮）：text() 按 Content-Type/<meta charset> 解码，
            // 不再裸 utf8——Shift_JIS/GBK/win-1252 站点经代理抓取此前必乱码
            text: async () => {
              const { decodeHtmlBuffer } = await import("@/lib/response-decoder");
              const ct = res.headers["content-type"];
              return decodeHtmlBuffer(rawBuf, Array.isArray(ct) ? ct[0] : ct);
            },
            buffer: () => Promise.resolve(rawBuf),
            headers: res.headers as Record<string, string | string[]>,
          });
        };
        res.on("end", finish);
        // 截断时 res.destroy() 不会触发 end，只会触发 close——用已收字节完成响应，防 Promise 悬挂
        res.on("close", () => { if (truncated) finish(); });
        res.on("error", (e) => { if (truncated) finish(); else reject(e); });
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

  return withProxySlot(() => doRequest(url, 0, options.method || "GET"));
}
