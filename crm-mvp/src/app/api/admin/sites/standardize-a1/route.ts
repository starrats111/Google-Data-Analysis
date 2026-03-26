import { NextRequest } from "next/server";
import { serializeData } from "@/lib/auth";
import { apiSuccess, apiError } from "@/lib/constants";
import { withAdmin } from "@/lib/api-handler";
import prisma from "@/lib/prisma";
import { applyA1SiteStandard, verifyConnection, verifyPublicSiteAccess } from "@/lib/remote-publisher";

// POST /api/admin/sites/standardize-a1 — 将已有站点远程目录标准化为 A1 并回写库内架构字段
export const POST = withAdmin(async (req: NextRequest) => {
  const { id } = await req.json();
  if (!id) return apiError("缺少站点 ID");

  const site = await prisma.publish_sites.findFirst({
    where: { id: BigInt(id), is_deleted: 0 },
  });
  if (!site?.site_path) return apiError("站点不存在或未配置路径");

  const a1 = await applyA1SiteStandard(site.site_path, site.domain);
  if (!a1.ok) return apiError(a1.error || "A1 标准化失败");

  const checks = await verifyConnection(site.site_path);
  if (!checks.valid) {
    return apiError(checks.error || "标准化后验证仍未通过，请检查 SSH 与目录权限");
  }

  const publicAccess = await verifyPublicSiteAccess(site.domain);
  const fullyVerified = checks.valid && publicAccess.ok;

  await prisma.publish_sites.update({
    where: { id: site.id },
    data: {
      verified: fullyVerified ? 1 : 0,
      site_type: checks.site_type,
      data_js_path: checks.data_js_path,
      article_var_name: checks.article_var_name,
      article_html_pattern: checks.article_html_pattern,
    },
  });

  return apiSuccess({
    site_id: serializeData(site.id),
    merged_count: a1.merged_count ?? 0,
    checks: serializeData(checks),
    publicAccess,
    fullyVerified,
  }, fullyVerified ? "已标准化为 A1 并完成验证" : "已标准化为 A1，但公网访问未通过");
});
