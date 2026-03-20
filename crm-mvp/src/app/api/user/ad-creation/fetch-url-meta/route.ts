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

  const url = new URL(req.url).searchParams.get("url");
  if (!url) return apiError("缺少 url 参数");

  try {
    new URL(url);
  } catch {
    return apiError("URL 格式无效");
  }

  let meta = await fetchUrlMeta(url);

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

  return apiSuccess({
    title: cleanTitle.slice(0, 25),
    description: meta.description.slice(0, 35),
    fullTitle: meta.title,
    fullDescription: meta.description,
    ok: meta.ok && !meta.isSoft404,
    finalUrl: meta.finalUrl,
    isSoft404: meta.isSoft404,
  });
}
