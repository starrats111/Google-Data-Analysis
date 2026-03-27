import { NextRequest } from "next/server";
import { getUserFromRequest } from "@/lib/auth";
import { apiSuccess, apiError } from "@/lib/constants";
import { tryValidateUrl, isJsRedirectUrl } from "@/lib/url-validator";

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
