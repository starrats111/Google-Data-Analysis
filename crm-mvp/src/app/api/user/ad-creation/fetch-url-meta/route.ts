import { NextRequest } from "next/server";
import { getUserFromRequest } from "@/lib/auth";
import { apiSuccess, apiError } from "@/lib/constants";
import { fetchUrlMeta } from "@/lib/crawler";

const JS_REDIRECT_PATTERNS = [
  /\/httpservice\//i, /\/enablejs/i, /\/cdn-cgi\/challenge/i,
  /\/captcha/i, /\/turnstile\//i, /\/bot-check/i,
];

/**
 * GET /api/user/ad-creation/fetch-url-meta?url=xxx
 * 获取指定 URL 的标题和描述（用于手动输入 sitelink 时自动填充）
 * 返回重定向后的真实 URL，检测软 404
 */
export async function GET(req: NextRequest) {
  const user = getUserFromRequest(req);
  if (!user) return apiError("未授权", 401);

  const { searchParams } = new URL(req.url);
  const url = searchParams.get("url");
  const country = (searchParams.get("country") || "").toUpperCase() || undefined;
  if (!url) return apiError("缺少 url 参数");

  try {
    new URL(url);
  } catch {
    return apiError("URL 格式无效");
  }

  // 传入 country 以便 fetchUrlMeta 使用对应国家代理（避免国家 IP 封锁导致 title 获取失败）
  let meta = await fetchUrlMeta(url, undefined, country);

  // 如果失败且是 JS 重定向 URL，尝试获取基础域名的信息
  if (!meta.ok && JS_REDIRECT_PATTERNS.some((p) => p.test(url))) {
    try {
      const baseUrl = new URL(url).origin;
      const baseMeta = await fetchUrlMeta(baseUrl);
      if (baseMeta.ok) {
        meta = baseMeta;
      }
    } catch {}
  }

  let cleanTitle = meta.title;
  if (cleanTitle) {
    cleanTitle = cleanTitle
      .replace(/\s*[\|–—]\s*[^|–—]{0,40}$/, "")
      .replace(/\s*-\s*[A-Z][a-zA-Z\s]{0,30}$/, "")
      .trim();
  }

  // 当页面 title 无法获取时（代理/直连均被 WAF 拦截），从 URL 路径生成兜底 title，
  // 让用户有一个合理的填写起点而不是完全空白
  let fallbackTitle = "";
  if (!cleanTitle) {
    try {
      const segs = new URL(url).pathname
        .replace(/\.(html?|php|aspx?|ct|cfm|asp)$/i, "")
        .split("/")
        .filter((s) => s.length > 1);
      if (segs.length > 0) {
        fallbackTitle = segs
          .map((s) => s.replace(/[-_+]/g, " ").replace(/\b\w/g, (c) => c.toUpperCase()))
          .join(" ")
          .slice(0, 25)
          .trim();
      }
    } catch {}
  }

  return apiSuccess({
    title: (cleanTitle || fallbackTitle).slice(0, 25),
    description: meta.description.slice(0, 35),
    fullTitle: meta.title,
    fullDescription: meta.description,
    ok: meta.ok && !meta.isSoft404,
    isFallbackTitle: !meta.ok && !!fallbackTitle,
    finalUrl: meta.finalUrl,
    isSoft404: meta.isSoft404,
  });
}
