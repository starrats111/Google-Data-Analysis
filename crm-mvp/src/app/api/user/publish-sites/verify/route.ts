import { NextRequest } from "next/server";
import { getUserFromRequest, serializeData } from "@/lib/auth";
import { apiSuccess, apiError } from "@/lib/constants";
import prisma from "@/lib/prisma";
import { verifyConnection } from "@/lib/remote-publisher";

// POST /api/user/publish-sites/verify — 验证站点目录（SSH 连接 + 架构检测）
export async function POST(req: NextRequest) {
  const user = getUserFromRequest(req);
  if (!user) return apiError("未授权", 401);

  const { id } = await req.json();
  if (!id) return apiError("缺少站点 ID");

  const site = await prisma.publish_sites.findFirst({
    where: { id: BigInt(id), is_deleted: 0 },
  });
  if (!site) return apiError("站点不存在", 404);
  if (!site.site_path) return apiError("站点路径未配置");

  const checks = await verifyConnection(site.site_path);

  // 如果检测到架构类型，自动更新
  if (checks.site_type) {
    const updateData: Record<string, unknown> = {
      verified: checks.valid ? 1 : 0,
    };
    if (checks.site_type !== site.site_type) {
      updateData.site_type = checks.site_type;
      updateData.data_js_path = checks.data_js_path || site.data_js_path;
      updateData.article_var_name = checks.article_var_name;
      updateData.article_html_pattern = checks.article_html_pattern;
    }
    await prisma.publish_sites.update({
      where: { id: BigInt(id) },
      data: updateData,
    });
  } else if (checks.valid) {
    await prisma.publish_sites.update({
      where: { id: BigInt(id) },
      data: { verified: 1 },
    });
  }

  return apiSuccess({
    site_id: serializeData(site.id),
    site_name: site.site_name,
    checks,
  });
}
