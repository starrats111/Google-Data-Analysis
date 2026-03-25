import { NextRequest } from "next/server";
import { serializeData } from "@/lib/auth";
import { apiSuccess, apiError } from "@/lib/constants";
import { withAdmin } from "@/lib/api-handler";
import prisma from "@/lib/prisma";
import { verifyConnection, verifyPublicSiteAccess, getSiteRoot } from "@/lib/remote-publisher";

// 获取所有站点列表（管理员 + 用户端共用，用户端只读）
export const GET = withAdmin(async () => {
  const sites = await prisma.publish_sites.findMany({
    where: { is_deleted: 0 },
    orderBy: { created_at: "desc" },
  });
  return apiSuccess(serializeData(sites));
});

// 添加站点（管理员）
export const POST = withAdmin(async (req: NextRequest) => {
  const { site_name, domain } = await req.json();
  if (!site_name || !domain) return apiError("站点名称和域名不能为空");

  const domainClean = domain.trim().toLowerCase().replace(/^https?:\/\//, "").replace(/\/+$/, "");

  const existing = await prisma.publish_sites.findFirst({
    where: { domain: domainClean, is_deleted: 0 },
  });
  if (existing) return apiError(`域名 ${domainClean} 已存在`);

  const siteRoot = await getSiteRoot();
  const sitePath = `${siteRoot}/${domainClean}`;

  let siteType: string | null = null;
  let dataJsPath: string | null = "js/articles-index.js";
  let articleVarName: string | null = null;
  let articleHtmlPattern: string | null = null;
  let verified = 0;

  try {
    const checks = await verifyConnection(sitePath);
    const publicAccess = await verifyPublicSiteAccess(domainClean);
    if (checks.valid && publicAccess.ok) {
      verified = 1;
    }
    if (checks.site_type) {
      siteType = checks.site_type;
      dataJsPath = checks.data_js_path || dataJsPath;
      articleVarName = checks.article_var_name;
      articleHtmlPattern = checks.article_html_pattern;
    }
  } catch (err) {
    console.warn("[admin/sites] SSH 验证跳过:", err);
  }

  const site = await prisma.publish_sites.create({
    data: {
      site_name: site_name.trim(),
      domain: domainClean,
      site_path: sitePath,
      site_type: siteType,
      data_js_path: dataJsPath,
      article_var_name: articleVarName,
      article_html_pattern: articleHtmlPattern,
      deploy_type: "bt_ssh",
      verified,
    },
  });

  return apiSuccess(serializeData(site));
});

// 更新站点（管理员）
export const PUT = withAdmin(async (req: NextRequest) => {
  const { id, site_name, domain, status } = await req.json();
  if (!id) return apiError("缺少 ID");

  const data: Record<string, unknown> = {};
  if (site_name !== undefined) data.site_name = site_name;
  if (status !== undefined) data.status = status;

  if (domain !== undefined) {
    const domainClean = domain.trim().toLowerCase().replace(/^https?:\/\//, "").replace(/\/+$/, "");
    data.domain = domainClean;
    data.site_path = `${await getSiteRoot()}/${domainClean}`;
    data.verified = 0;
    data.site_type = null;
  }

  await prisma.publish_sites.update({ where: { id: BigInt(id) }, data });
  return apiSuccess(null, "更新成功");
});

// 删除站点（管理员，软删除）
export const DELETE = withAdmin(async (req: NextRequest) => {
  const { id } = await req.json();
  if (!id) return apiError("缺少 ID");

  await prisma.publish_sites.update({ where: { id: BigInt(id) }, data: { is_deleted: 1 } });
  return apiSuccess(null, "删除成功");
});
