import { NextRequest } from "next/server";
import { getUserFromRequest, serializeData } from "@/lib/auth";
import { apiSuccess, apiError } from "@/lib/constants";
import prisma from "@/lib/prisma";
import { publishArticleToSite, unpublishArticleFromSite } from "@/lib/remote-publisher";

// POST — 发布文章到站点（SSH 推送文件到宝塔）
export async function POST(req: NextRequest) {
  const user = getUserFromRequest(req);
  if (!user) return apiError("未授权", 401);

  const { article_id, site_id } = await req.json();
  if (!article_id || !site_id) return apiError("缺少文章 ID 或站点 ID");

  // 查询文章
  const article = await prisma.articles.findFirst({
    where: { id: BigInt(article_id), user_id: BigInt(user.userId), is_deleted: 0 },
  });
  if (!article) return apiError("文章不存在", 404);
  if (!article.title || !article.content) return apiError("文章标题或内容为空，无法发布");

  // 查询站点（全局站点，不再按 user_id 过滤）
  const site = await prisma.publish_sites.findFirst({
    where: { id: BigInt(site_id), is_deleted: 0, status: "active" },
  });
  if (!site) return apiError("站点不存在或未启用", 404);
  if (!site.site_path || !site.domain) return apiError("站点路径或域名未配置");

  // 生成 slug
  const slug = article.slug || article.title
    .toLowerCase().trim()
    .replace(/[^\w\s-]/g, "")
    .replace(/[\s_-]+/g, "-")
    .replace(/^-+|-+$/g, "");

  // SSH 推送文件到宝塔（含图片本地化）
  const result = await publishArticleToSite(
        {
          id: String(article.id),
          title: article.title,
          slug,
          content: article.content,
          category: article.category || "General",
          images: article.images,
          trackingLink: article.tracking_link,
        },
    {
      site_path: site.site_path,
      site_type: site.site_type,
      data_js_path: site.data_js_path,
      article_var_name: site.article_var_name,
      article_html_pattern: site.article_html_pattern,
      domain: site.domain,
    }
  );

  if (!result.success) {
    return apiError(`发布失败: ${result.error}`, 500);
  }

  // 更新文章状态 + 同步本地化 content
  await prisma.articles.update({
    where: { id: BigInt(article_id) },
    data: {
      publish_site_id: BigInt(site_id),
      slug,
      status: "published",
      published_at: new Date(),
      published_url: result.url || null,
      content: result.updatedContent || article.content,
    },
  });

  return apiSuccess({ url: result.url }, "发布成功");
}

// DELETE — 从站点撤回文章
export async function DELETE(req: NextRequest) {
  const user = getUserFromRequest(req);
  if (!user) return apiError("未授权", 401);

  const { article_id } = await req.json();
  if (!article_id) return apiError("缺少文章 ID");

  const article = await prisma.articles.findFirst({
    where: { id: BigInt(article_id), user_id: BigInt(user.userId), is_deleted: 0 },
  });
  if (!article) return apiError("文章不存在", 404);
  if (!article.publish_site_id) return apiError("文章未发布到任何站点");

  const site = await prisma.publish_sites.findFirst({
    where: { id: article.publish_site_id, is_deleted: 0 },
  });
  if (!site || !site.site_path) return apiError("关联站点不存在");

  const result = await unpublishArticleFromSite(
    String(article.id),
    article.slug || "",
    {
      site_path: site.site_path,
      site_type: site.site_type,
      data_js_path: site.data_js_path,
      article_var_name: site.article_var_name,
      article_html_pattern: site.article_html_pattern,
    }
  );

  if (!result.success) {
    return apiError(`撤回失败: ${result.error}`, 500);
  }

  // 更新文章状态
  await prisma.articles.update({
    where: { id: BigInt(article_id) },
    data: {
      status: "preview",
      publish_site_id: null,
      published_url: null,
    },
  });

  return apiSuccess(null, "已从站点撤回");
}
