/**
 * C-112 / D-046.C — Step 1：URL 可达性闸门
 *
 * 07 决策 X3=B 警告但允许：finalUrl HTTP 200 通过 / 4xx/5xx 警告但允许员工继续生成，
 * 重试 3 次仍失败时 emitSSE 'url_unreachable_warning' 让员工知情。
 *
 * 跟随 redirect chain（最多 5 跳）到最终落地页，确保即使商家用了短链/promo 链也能检查到真正的目标页。
 *
 * 设计目标：绝对不让"网站打不开的广告"被推送到 Google Ads（会被立刻下架）。
 */

export interface ReachabilityResult {
  /** 最终落地页 URL（跟完所有 redirect 后）；fail 时等于输入 url */
  finalUrl: string;
  /** 最后一次响应 HTTP 状态码；网络错误 = 0 */
  statusCode: number;
  /** 是否通过：HTTP 2xx 即 reachable；3xx 跟随完了仍 2xx 也算 reachable */
  reachable: boolean;
  /** redirect chain 长度 */
  redirectHops: number;
  /** 重试次数（0 = 一次成功） */
  attempts: number;
  /** 失败原因（reachable=false 时填）；网络错误 / HTTP 4xx / 5xx / too_many_redirects / timeout */
  failureReason?: string;
  /** redirect chain 记录（用于诊断） */
  chain?: { url: string; status: number }[];
  /** 总耗时 ms */
  elapsedMs: number;
}

export interface ReachabilityOptions {
  /** 单次请求超时 ms，默认 8000 */
  timeoutMs?: number;
  /** 失败重试次数，默认 3（X3=B 重试 3 次仍失败才警告） */
  maxRetries?: number;
  /** redirect 最大跳数，默认 10（联盟追踪链 6-15 跳常态，5 跳会误判 too_many_redirects） */
  maxRedirects?: number;
  /** 重试间退避基数 ms，默认 1500（指数退避 1.5s/3s/6s） */
  retryBaseMs?: number;
  /**
   * 目标国家代码（如 US/GB）。CRAWL-04：当直连产生「连接级失败」（timeout/network_error/server_error）
   * 时，本服务器出口 IP 可能被目标站按地域/IP 封锁（实测 rcwilley.com 对腾讯云机房直连超时、
   * 对美国住宅代理却 200+50 图）——这与「Google 美国爬虫仍可达」是同一种情况。
   * 配了该国爬取代理时，用代理再探一次，避免把「我们到不了」误判成「站点死了」而硬卡提交。
   */
  country?: string;
}

/**
 * 检查 URL 可达性 + 跟随 redirect chain。
 *
 * 不抛错；任何异常都会被捕获并返回 reachable=false。
 *
 * @example
 *   const r = await checkReachability("https://merchant.com/promo?utm=ads");
 *   if (!r.reachable) emitSSE("url_unreachable_warning", r);
 */
export async function checkReachability(
  url: string,
  opts: ReachabilityOptions = {},
): Promise<ReachabilityResult> {
  const timeoutMs = opts.timeoutMs ?? 8000;
  const maxRetries = opts.maxRetries ?? 3;
  const maxRedirects = opts.maxRedirects ?? 10;
  const retryBaseMs = opts.retryBaseMs ?? 1500;

  const startedAt = Date.now();
  let attempts = 0;
  let lastResult: Omit<ReachabilityResult, "attempts" | "elapsedMs"> = {
    finalUrl: url,
    statusCode: 0,
    reachable: false,
    redirectHops: 0,
    failureReason: "not_started",
    chain: [],
  };

  for (let attempt = 0; attempt < maxRetries; attempt++) {
    attempts = attempt + 1;
    try {
      lastResult = await singleProbeWithRedirects(url, {
        timeoutMs,
        maxRedirects,
      });
      if (lastResult.reachable) break;
      // 4xx 客户端错误重试通常无意义，但 429/408 值得重试
      if (
        lastResult.statusCode >= 400 &&
        lastResult.statusCode < 500 &&
        lastResult.statusCode !== 408 &&
        lastResult.statusCode !== 429
      ) {
        break; // 永久性 4xx，提前中止重试
      }
    } catch (err) {
      lastResult = {
        finalUrl: url,
        statusCode: 0,
        reachable: false,
        redirectHops: 0,
        failureReason:
          err instanceof Error ? `network_error:${err.message.slice(0, 80)}` : "unknown",
        chain: [],
      };
    }

    if (attempt < maxRetries - 1) {
      // 指数退避（1.5s → 3s → 6s）
      const backoff = retryBaseMs * Math.pow(2, attempt);
      await new Promise((r) => setTimeout(r, backoff));
    }
  }

  // CRAWL-04：直连「连接级失败」时走该国代理兜底探一次。
  //   对 timeout / network_error / server_error 触发——这些是「连不上/服务端抖动」，
  //   本机出口 IP 被地域封锁恰属此类（rcwilley 实证）。
  //   404/410 同样走代理复核：部分 CDN/WAF 对机房 IP、非目标国 IP 不回 403 而是直接回 404
  //   （rad.eu 实证：直连 404、真实浏览器/目标国用户 200），直连 404 ≠ 页面真的不存在。
  //   代理探到 2xx 即视为可达放行；代理也 404 才维持死链结论。
  if (!lastResult.reachable && opts.country) {
    const fr = lastResult.failureReason || "";
    const isConnLevel = fr.startsWith("network_error") || fr === "timeout" || fr === "server_error";
    const isDeadClientError = fr === "client_error" && (lastResult.statusCode === 404 || lastResult.statusCode === 410);
    // 2026-07-13：403/429 也走代理复核，与 tryValidateUrl 对齐。此前二者对 403 的处理相反
    // （校验器代理重试、可达性不重试），同一链接"预览绿、生成黄"分裂；403 本就是
    // 地理封锁/机房 IP 拦截的高发状态码，目标国住宅代理复核是最直接的证伪手段。
    const isGeoBlockSuspect = fr === "client_error" && (lastResult.statusCode === 403 || lastResult.statusCode === 429);
    if (isConnLevel || isDeadClientError || isGeoBlockSuspect) {
      // 代理链路比直连慢（实测 SOCKS5 取 rcwilley ~6.3s），给更宽松超时避免临界误判
      const viaProxy = await probeViaProxy(url, opts.country, Math.max(timeoutMs, 15000), maxRedirects).catch(() => null);
      if (viaProxy && viaProxy.reachable) {
        console.warn(`[Reachability] CRAWL-04：直连失败(${fr})但 ${opts.country} 代理可达，判定为可达放行 finalUrl=${viaProxy.finalUrl} status=${viaProxy.statusCode}`);
        lastResult = viaProxy;
      }
    }
  }

  return {
    ...lastResult,
    attempts,
    elapsedMs: Date.now() - startedAt,
  };
}

/**
 * CRAWL-04：经该国爬取代理探测可达性（直连失败时兜底）。
 * 复用 crawl-proxy 的 SOCKS5 代理 + fetchViaProxy（内部跟随重定向）。
 * 未配代理 / 探测失败 → 返回 null，调用方维持直连结论。
 */
async function probeViaProxy(
  url: string,
  country: string,
  timeoutMs: number,
  maxRedirects: number,
): Promise<Omit<ReachabilityResult, "attempts" | "elapsedMs"> | null> {
  const { getProxyUrlForCountry, fetchViaProxy } = await import("@/lib/crawl-proxy");
  const proxyUrl = await getProxyUrlForCountry(country).catch(() => null);
  if (!proxyUrl) return null;

  const ctrl = new AbortController();
  const tm = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const resp = await fetchViaProxy(
      url,
      {
        method: "GET",
        headers: {
          // UA 与 url-validator 的 UA_POOL[0] 保持一致（Chrome/135），消除两套验证器指纹不一致导致的判定分歧
          "User-Agent":
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/135.0.0.0 Safari/537.36",
          "Accept-Language": "en-US,en;q=0.9",
        },
        signal: ctrl.signal,
      },
      proxyUrl,
      maxRedirects,
    );
    const reachable = resp.status >= 200 && resp.status < 300;
    return {
      finalUrl: resp.url || url,
      statusCode: resp.status,
      reachable,
      redirectHops: 0,
      failureReason: reachable
        ? undefined
        : resp.status >= 500
          ? "server_error"
          : "client_error",
      chain: [],
    };
  } catch {
    return null;
  } finally {
    clearTimeout(tm);
  }
}

/**
 * D-050 第2块：判断"是否硬性不可达"——用于提交前硬卡（稳不被拒优先）。
 *
 * 只在"确定性死链"时返回 true：
 *   - DNS/连接失败（network_error）、超时（timeout）、5xx（server_error）
 *   - 坏重定向（too_many_redirects / redirect_no_location / redirect_bad_location）
 *   - 永久不存在（404 / 410）
 *
 * 对 401/403/429 等返回 false：这些大概率是反爬/限流（Cloudflare Bot Fight / 速率限制），
 * 但 Google 自家爬虫与白名单仍可能正常访问，硬卡会误杀正常落地页，违背"不要误伤"。
 */
export function isHardUnreachable(r: ReachabilityResult): boolean {
  if (r.reachable) return false;
  const fr = r.failureReason || "";
  if (fr.startsWith("network_error") || fr === "timeout" || fr === "server_error") return true;
  if (fr === "too_many_redirects" || fr === "redirect_no_location" || fr === "redirect_bad_location") return true;
  if (fr === "client_error" && (r.statusCode === 404 || r.statusCode === 410)) return true;
  return false;
}

/**
 * 单次探测 + 跟随 redirect chain。
 *
 * 使用 manual redirect 模式逐跳跟，每跳都记录 status。
 * 设置 User-Agent 模拟主流浏览器避免被部分站直接 403（如 Cloudflare 默认挡 fetch UA）。
 */
async function singleProbeWithRedirects(
  startUrl: string,
  opts: { timeoutMs: number; maxRedirects: number },
): Promise<Omit<ReachabilityResult, "attempts" | "elapsedMs">> {
  const chain: { url: string; status: number }[] = [];
  let currentUrl = startUrl;
  let hops = 0;

  // 与主流浏览器 UA 保持一致，避免被反爬挡：fetch 默认 UA 在 Cloudflare/Akamai 上经常被 403/429
  // 版本与 url-validator 的 UA_POOL[0] 对齐（Chrome/135），消除两套验证器 UA 不一致导致的判定分歧
  const headers: Record<string, string> = {
    "User-Agent":
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/135.0.0.0 Safari/537.36",
    Accept:
      "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
    "Accept-Language": "en-US,en;q=0.9",
  };

  while (hops <= opts.maxRedirects) {
    let res: Response;
    try {
      // 先尝试 HEAD（更快、不下载 body）；若 HEAD 不被允许会 405/501 等，回退 GET
      res = await fetch(currentUrl, {
        method: "HEAD",
        redirect: "manual",
        headers,
        signal: AbortSignal.timeout(opts.timeoutMs),
      });
      // 部分站点对 HEAD 处理异常：405/501（不支持）之外，不少 CDN/WAF 对 HEAD 直接回
      // 404/403（GET 却 200，rad.eu 实证）。凡 HEAD 拿到 >=400 一律换 GET 复核一次，
      // 以 GET 结果为准，避免把「HEAD 被针对」误判成死链。
      if (res.status >= 400) {
        res = await fetch(currentUrl, {
          method: "GET",
          redirect: "manual",
          headers,
          signal: AbortSignal.timeout(opts.timeoutMs),
        });
      }
    } catch (err) {
      // 网络层异常（DNS/Timeout/TLS） → 不再继续跟跳
      return {
        finalUrl: currentUrl,
        statusCode: 0,
        reachable: false,
        redirectHops: hops,
        failureReason:
          err instanceof Error
            ? err.name === "TimeoutError" || /timeout/i.test(err.message)
              ? "timeout"
              : `network_error:${err.message.slice(0, 80)}`
            : "unknown",
        chain,
      };
    }

    chain.push({ url: currentUrl, status: res.status });

    // 2xx = 可达
    if (res.status >= 200 && res.status < 300) {
      return {
        finalUrl: currentUrl,
        statusCode: res.status,
        reachable: true,
        redirectHops: hops,
        chain,
      };
    }

    // 3xx = 继续跟
    if (res.status >= 300 && res.status < 400) {
      const location = res.headers.get("location");
      if (!location) {
        return {
          finalUrl: currentUrl,
          statusCode: res.status,
          reachable: false,
          redirectHops: hops,
          failureReason: "redirect_no_location",
          chain,
        };
      }
      // 合成绝对 URL（相对 location → 基于当前 URL 解析）
      try {
        const next = new URL(location, currentUrl).toString();
        currentUrl = next;
        hops += 1;
        continue;
      } catch {
        return {
          finalUrl: currentUrl,
          statusCode: res.status,
          reachable: false,
          redirectHops: hops,
          failureReason: "redirect_bad_location",
          chain,
        };
      }
    }

    // 4xx / 5xx 不可达
    return {
      finalUrl: currentUrl,
      statusCode: res.status,
      reachable: false,
      redirectHops: hops,
      failureReason: res.status >= 500 ? "server_error" : "client_error",
      chain,
    };
  }

  // 跳数超限
  return {
    finalUrl: currentUrl,
    statusCode: 310,
    reachable: false,
    redirectHops: hops,
    failureReason: "too_many_redirects",
    chain,
  };
}
