import { NextRequest } from "next/server";
import { getUserFromRequest, serializeData } from "@/lib/auth";
import { apiSuccess, apiError } from "@/lib/constants";
import { verifyPublishSiteById } from "@/lib/publish-site-verify";

// POST /api/user/publish-sites/verify — 用户端验证站点目录（SSH 连接 + 架构检测）
export async function POST(req: NextRequest) {
  const user = getUserFromRequest(req);
  if (!user) return apiError("未授权", 401);

  const { id } = await req.json();
  if (!id) return apiError("缺少站点 ID");

  const result = await verifyPublishSiteById(BigInt(id));
  if (!result.ok) return apiError(result.message, result.status);

  return apiSuccess({
    site_id: serializeData(result.site.id),
    site_name: result.site.site_name,
    checks: result.checks,
    publicAccess: result.publicAccess,
    autoStandardizeAttempted: result.autoStandardizeAttempted,
    a1Standardization: result.a1Standardization,
    autoRegisterAttempted: result.autoRegisterAttempted,
    panelRegistration: result.panelRegistration,
  });
}
