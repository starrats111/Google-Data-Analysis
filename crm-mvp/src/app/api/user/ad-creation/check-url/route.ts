import { NextRequest } from "next/server";
import { getUserFromRequest } from "@/lib/auth";
import { apiSuccess, apiError } from "@/lib/constants";

const UA_POOL = [
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/135.0.0.0 Safari/537.36",
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/135.0.0.0 Safari/537.36",
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:136.0) Gecko/20100101 Firefox/136.0",
  "Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)",
];

/**
 * JS 重定向 / 挑战页面的 URL 模式
 * 这些 URL 本身不是内容页，是 bot 检测中间页
 */
const JS_REDIRECT_PATTERNS = [
  /\/httpservice\/retry/i,
  /\/enablejs/i,
  /\/cdn-cgi\/challenge/i,
  /\/cdn-cgi\/l\/chk_/i,
  /[\?&]__cf_chl_/i,
  /\/turnstile\//i,
  /\/captcha\//i,
  /\/bot-check/i,
  /\/human-verification/i,
];

function isJsRedirectUrl(url: string): boolean {
  return JS_REDIRECT_PATTERNS.some((p) => p.test(url));
}

function buildStealthHeaders(ua: string): Record<string, string> {
  const headers: Record<string, string> = {
    "User-Agent": ua,
    Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    "Accept-Language": "en-US,en;q=0.9",
    "Accept-Encoding": "gzip, deflate, br",
    "Cache-Control": "no-cache",
    "Upgrade-Insecure-Requests": "1",
    Referer: "https://www.google.com/",
    DNT: "1",
    Connection: "keep-alive",
  };
  if (ua.includes("Chrome") && !ua.includes("Firefox")) {
    headers["Sec-Fetch-Dest"] = "document";
    headers["Sec-Fetch-Mode"] = "navigate";
    headers["Sec-Fetch-Site"] = "none";
    headers["Sec-Fetch-User"] = "?1";
  }
  return headers;
}

/**
 * 通过内容判断页面是否为有效页面（即使 status >= 400）
 * 如果 HTML 包含正常页面内容（<main>, <article>, 产品区域等），视为有效
 */
function isValidPageContent(html: string): boolean {
  const lower = html.toLowerCase();
  if (html.length < 500) return false;
  if (html.length > 50000) return true;

  const blockedSignals = [
    "checking your browser", "just a moment",
    "enable javascript and cookies", "please verify you are human",
    "access denied", "request blocked",
  ];
  const blockedHits = blockedSignals.filter((s) => lower.includes(s)).length;
  if (blockedHits >= 2 && html.length < 10000) return false;

  const contentSignals = [
    "<main", "<article", "<section", "class=\"product",
    "class=\"content", "class=\"hero", "class=\"shop",
    "class=\"page", "class=\"container",
  ];
  const contentHits = contentSignals.filter((s) => lower.includes(s)).length;
  if (contentHits >= 1 && html.length > 3000) return true;

  const imgCount = (lower.match(/<img/g) || []).length;
  if (imgCount >= 2 && html.length > 5000) return true;

  if (html.length > 10000) return true;

  return false;
}

async function tryValidateUrl(
  url: string,
): Promise<{ ok: boolean; status: number; finalUrl: string; reason?: string }> {
  for (let i = 0; i < UA_POOL.length; i++) {
    const ua = UA_POOL[i];
    const headers = buildStealthHeaders(ua);

    // HEAD 请求
    try {
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), 10000);
      const res = await fetch(url, {
        method: "HEAD", redirect: "follow", signal: ctrl.signal, headers,
      });
      clearTimeout(t);

      if (res.status < 400) {
        const finalUrl = res.url;
        try {
          const origDomain = new URL(url).hostname.replace(/^www\./, "");
          const finalDomain = new URL(finalUrl).hostname.replace(/^www\./, "");
          if (origDomain !== finalDomain && !finalDomain.includes(origDomain) && !origDomain.includes(finalDomain)) {
            return { ok: false, status: res.status, finalUrl, reason: `链接被重定向到不同域名 ${finalDomain}` };
          }
        } catch {}
        return { ok: true, status: res.status, finalUrl };
      }

      if (res.status === 404 || res.status === 410) {
        // 有些服务器对 HEAD 返回 404 但 GET 正常，用 GET 重试
        const getResult = await tryGet(url, ua);
        if (getResult) return getResult;
        if (i < UA_POOL.length - 1) continue;
        return { ok: false, status: res.status, finalUrl: url, reason: `页面返回 ${res.status}（页面不存在）` };
      }

      if (res.status === 403) {
        // 先检查是否 Cloudflare
        try {
          const body = await res.text().catch(() => "");
          const isCf = body.includes("Just a moment") || body.includes("cf_chl_opt") ||
            body.includes("cloudflare") || body.includes("cf-ray");
          if (isCf) {
            return { ok: true, status: 200, finalUrl: url, reason: "Cloudflare 保护（链接有效）" };
          }
        } catch {}
        // GET 重试
        const getResult = await tryGet(url, ua);
        if (getResult) return getResult;
        if (i < UA_POOL.length - 1) continue;
      }

      if (res.status === 405) {
        // Method Not Allowed - 尝试 GET
        const getResult = await tryGet(url, ua);
        if (getResult) return getResult;
        if (i < UA_POOL.length - 1) continue;
      }

      if (res.status >= 500) {
        if (i < UA_POOL.length - 1) continue;
        return { ok: false, status: res.status, finalUrl: url, reason: `服务器错误 ${res.status}` };
      }

      // 其他 4xx，GET 重试
      const getResult = await tryGet(url, ua);
      if (getResult) return getResult;
      if (i < UA_POOL.length - 1) continue;
      return { ok: false, status: res.status, finalUrl: url, reason: `请求失败 ${res.status}` };
    } catch (err) {
      const msg = err instanceof Error ? err.message : "";
      if (msg.includes("abort")) {
        if (i < UA_POOL.length - 1) continue;
        return { ok: false, status: 0, finalUrl: url, reason: "请求超时" };
      }
      if (i < UA_POOL.length - 1) continue;
    }
  }

  return { ok: false, status: 0, finalUrl: url, reason: "所有验证方式均失败" };
}

async function tryGet(
  url: string,
  ua: string,
): Promise<{ ok: boolean; status: number; finalUrl: string; reason?: string } | null> {
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 12000);
    const res = await fetch(url, {
      method: "GET", redirect: "follow", signal: ctrl.signal,
      headers: buildStealthHeaders(ua),
    });
    clearTimeout(t);

    if (res.status < 400) {
      return { ok: true, status: res.status, finalUrl: res.url };
    }

    // 即使 status >= 400，检查内容是否是有效页面
    const html = await res.text().catch(() => "");

    // 检查 Cloudflare
    const lower = html.toLowerCase();
    if (lower.includes("cloudflare") || lower.includes("cf-ray") || lower.includes("cf_chl_opt")) {
      return { ok: true, status: 200, finalUrl: url, reason: "Cloudflare 保护（链接有效）" };
    }

    // 检查内容质量
    if (isValidPageContent(html)) {
      return { ok: true, status: res.status, finalUrl: res.url, reason: "页面内容有效" };
    }
  } catch {}
  return null;
}

/**
 * GET /api/user/ad-creation/check-url?url=xxx
 * 验证站内链接是否真实有效
 * 使用和爬虫同级别的多UA策略、内容验证、JS重定向处理
 */
export async function GET(req: NextRequest) {
  const user = getUserFromRequest(req);
  if (!user) return apiError("未授权", 401);

  const { searchParams } = new URL(req.url);
  const url = searchParams.get("url");
  if (!url) return apiError("缺少 url 参数");

  try {
    new URL(url);
  } catch {
    return apiSuccess({ ok: false, reason: "URL 格式无效" });
  }

  // 如果是 JS 重定向/挑战 URL，验证基础域名
  if (isJsRedirectUrl(url)) {
    try {
      const baseUrl = new URL(url).origin;
      const baseResult = await tryValidateUrl(baseUrl);
      if (baseResult.ok) {
        return apiSuccess({
          ok: true, status: 200, finalUrl: url,
          note: "JS 重定向 URL（基础域名有效）",
          warning: "此链接包含 JS 重定向，建议使用直接页面链接",
        });
      }
    } catch {}
  }

  const result = await tryValidateUrl(url);
  return apiSuccess({
    ok: result.ok,
    status: result.status,
    finalUrl: result.finalUrl,
    reason: result.ok ? undefined : result.reason,
    note: result.ok ? result.reason : undefined,
  });
}
