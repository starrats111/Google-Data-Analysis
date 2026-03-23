import { NextRequest } from "next/server";
import { getUserFromRequest } from "@/lib/auth";
import { apiSuccess, apiError } from "@/lib/constants";

const UA_POOL = [
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/135.0.0.0 Safari/537.36",
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/135.0.0.0 Safari/537.36",
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:136.0) Gecko/20100101 Firefox/136.0",
  "Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)",
];

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

const SOFT_404_SIGNALS = [
  "page not found", "page introuvable", "seite nicht gefunden",
  "página no encontrada", "pagina non trovata",
  "not found", "does not exist", "n'existe pas",
  "nichts gefunden", "has disappeared",
  "no longer available", "has been removed",
  "page doesn't exist", "page does not exist",
  "couldn't find", "could not find this page",
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

function extractTitle(html: string): string {
  const m = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  return m ? m[1].replace(/\s+/g, " ").trim() : "";
}

function checkSoft404(html: string): { isSoft404: boolean; reason?: string } {
  const title = extractTitle(html).toLowerCase();
  const lower = html.toLowerCase();

  if (title.includes("404") || title.includes("not found") || title.includes("page not found")) {
    return { isSoft404: true, reason: `页面标题含"${title.includes("404") ? "404" : "not found"}"（软 404）` };
  }

  for (const s of SOFT_404_SIGNALS) {
    if (title.includes(s)) {
      return { isSoft404: true, reason: `页面标题含"${s}"（软 404）` };
    }
  }

  if (html.length < 20000) {
    const hits = SOFT_404_SIGNALS.filter((s) => lower.includes(s));
    if (hits.length >= 2) {
      return { isSoft404: true, reason: `页面内容含多个 404 信号（软 404）` };
    }
  }

  return { isSoft404: false };
}

function isCloudflareChallenge(html: string): boolean {
  if (!html || html.length < 20) return false;
  const lower = html.toLowerCase();
  return lower.includes("just a moment") || lower.includes("cf_chl_opt") ||
    lower.includes("cloudflare") || lower.includes("cf-ray");
}

function isValidPageContent(html: string): boolean {
  const lower = html.toLowerCase();
  if (html.length < 500) return false;
  if (checkSoft404(html).isSoft404) return false;
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

type GetResult =
  | { type: "ok"; ok: boolean; status: number; finalUrl: string; reason?: string }
  | { type: "cloudflare" }
  | { type: "failed" };

/**
 * GET 请求获取页面内容，检查软 404 和 Cloudflare
 */
async function getAndCheck(url: string, ua: string): Promise<GetResult> {
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 12000);
    const res = await fetch(url, {
      method: "GET", redirect: "follow", signal: ctrl.signal,
      headers: buildStealthHeaders(ua),
    });
    clearTimeout(t);

    const html = await res.text().catch(() => "");

    if (isCloudflareChallenge(html)) {
      return { type: "cloudflare" };
    }

    if (res.status < 400) {
      const soft = checkSoft404(html);
      if (soft.isSoft404) {
        return { type: "ok", ok: false, status: res.status, finalUrl: res.url, reason: soft.reason };
      }
      return { type: "ok", ok: true, status: res.status, finalUrl: res.url };
    }

    if (isValidPageContent(html)) {
      return { type: "ok", ok: true, status: res.status, finalUrl: res.url, reason: "页面内容有效" };
    }
  } catch {}
  return { type: "failed" };
}

async function tryValidateUrl(
  url: string,
): Promise<{ ok: boolean; status: number; finalUrl: string; reason?: string }> {
  let cloudflareCount = 0;

  for (let i = 0; i < UA_POOL.length; i++) {
    const ua = UA_POOL[i];
    const headers = buildStealthHeaders(ua);

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

        const getResult = await getAndCheck(url, ua);
        if (getResult.type === "ok") return getResult;
        // GET 被 Cloudflare 拦截或失败 → HEAD 200 作为兜底
        return { ok: true, status: res.status, finalUrl };
      }

      if (res.status === 404 || res.status === 410) {
        const getResult = await getAndCheck(url, ua);
        if (getResult.type === "ok") return getResult;
        if (getResult.type === "cloudflare") { cloudflareCount++; if (i < UA_POOL.length - 1) continue; break; }
        if (i < UA_POOL.length - 1) continue;
        return { ok: false, status: res.status, finalUrl: url, reason: `页面返回 ${res.status}（页面不存在）` };
      }

      if (res.status === 403) {
        // HEAD 没有 body，直接用 GET 判断
        const getResult = await getAndCheck(url, ua);
        if (getResult.type === "ok") return getResult;
        if (getResult.type === "cloudflare") { cloudflareCount++; if (i < UA_POOL.length - 1) continue; break; }
        if (i < UA_POOL.length - 1) continue;
        return { ok: false, status: res.status, finalUrl: url, reason: `请求失败 ${res.status}` };
      }

      if (res.status === 405) {
        const getResult = await getAndCheck(url, ua);
        if (getResult.type === "ok") return getResult;
        if (getResult.type === "cloudflare") { cloudflareCount++; if (i < UA_POOL.length - 1) continue; break; }
        if (i < UA_POOL.length - 1) continue;
        return { ok: false, status: res.status, finalUrl: url, reason: `请求失败 ${res.status}` };
      }

      if (res.status >= 500) {
        if (i < UA_POOL.length - 1) continue;
        return { ok: false, status: res.status, finalUrl: url, reason: `服务器错误 ${res.status}` };
      }

      const getResult = await getAndCheck(url, ua);
      if (getResult.type === "ok") return getResult;
      if (getResult.type === "cloudflare") { cloudflareCount++; if (i < UA_POOL.length - 1) continue; break; }
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

  if (cloudflareCount > 0) {
    return { ok: true, status: 200, finalUrl: url, reason: "Cloudflare 保护，无法验证页面内容" };
  }

  return { ok: false, status: 0, finalUrl: url, reason: "所有验证方式均失败" };
}

/**
 * GET /api/user/ad-creation/check-url?url=xxx
 * 验证站内链接是否真实有效（含软 404 检测）
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
