import { NextRequest } from "next/server";
import { getUserFromRequest, serializeData } from "@/lib/auth";
import { apiSuccess, apiError } from "@/lib/constants";
import prisma from "@/lib/prisma";
import { verifyConnection, getSiteRoot } from "@/lib/remote-publisher";

// 获取站点列表（全局站点，所有用户可读）
export async function GET(req: NextRequest) {
  const user = getUserFromRequest(req);
  if (!user) return apiError("未授权", 401);

  const sites = await prisma.publish_sites.findMany({
    where: { is_deleted: 0 },
    orderBy: { created_at: "desc" },
  });
  return apiSuccess(serializeData(sites));
}

// 验证站点（保留给管理员使用）
export async function POST(req: NextRequest) {
  const user = getUserFromRequest(req);
  if (!user) return apiError("未授权", 401);

  const { id } = await req.json();
  if (!id) return apiError("缺少 ID");

  const site = await prisma.publish_sites.findUnique({ where: { id: BigInt(id) } });
  if (!site || site.is_deleted === 1) return apiError("站点不存在");

  const sitePath = site.site_path || `${await getSiteRoot()}/${site.domain}`;
  const checks = await verifyConnection(sitePath);

  if (checks.valid) {
    await prisma.publish_sites.update({
      where: { id: BigInt(id) },
      data: {
        verified: 1,
        site_type: checks.site_type,
        data_js_path: checks.data_js_path,
        article_var_name: checks.article_var_name,
        article_html_pattern: checks.article_html_pattern,
      },
    });
  }

  return apiSuccess({ checks: serializeData(checks) });
}
