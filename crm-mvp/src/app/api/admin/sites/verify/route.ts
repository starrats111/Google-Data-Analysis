import { NextRequest } from "next/server";
import { serializeData } from "@/lib/auth";
import { apiSuccess, apiError } from "@/lib/constants";
import { withAdmin } from "@/lib/api-handler";
import { verifyPublishSiteById } from "@/lib/publish-site-verify";

// POST /api/admin/sites/verify — 管理后台验证站点（走 admin_token，避免 /api/user 中间件拦截）
export const POST = withAdmin(async (req: NextRequest) => {
  const { id } = await req.json();
  if (!id) return apiError("缺少站点 ID");

  const result = await verifyPublishSiteById(BigInt(id));
  if (!result.ok) return apiError(result.message, result.status);

  return apiSuccess({
    site_id: serializeData(result.site.id),
    site_name: result.site.site_name,
    checks: result.checks,
  });
});
