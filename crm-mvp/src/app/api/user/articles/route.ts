import { NextRequest } from "next/server";
import { getUserFromRequest, serializeData } from "@/lib/auth";
import { apiSuccess, apiError } from "@/lib/constants";
import prisma from "@/lib/prisma";

// 获取文章列表（含商家名、站点信息）
export async function GET(req: NextRequest) {
  const user = getUserFromRequest(req);
  if (!user) return apiError("未授权", 401);

  const { searchParams } = new URL(req.url);
  const status = searchParams.get("status") || "";
  const merchant_id = searchParams.get("merchant_id") || "";
  const slug = searchParams.get("slug") || "";
  const page = parseInt(searchParams.get("page") || "1");
  const pageSize = parseInt(searchParams.get("pageSize") || "20");

  const where: Record<string, unknown> = {
    user_id: BigInt(user.userId),
    is_deleted: 0,
  };
  if (status) where.status = status;
  if (merchant_id) where.user_merchant_id = BigInt(merchant_id);
  if (slug) where.slug = slug;

  const [total, articles] = await Promise.all([
    prisma.articles.count({ where: where as never }),
    prisma.articles.findMany({
      where: where as never,
      orderBy: { created_at: "desc" },
      skip: (page - 1) * pageSize,
      take: pageSize,
    }),
  ]);

  // 批量查询关联的商家和站点信息
  const merchantIds = [...new Set(articles.filter((a) => a.user_merchant_id).map((a) => a.user_merchant_id!))];
  const siteIds = [...new Set(articles.filter((a) => a.publish_site_id).map((a) => a.publish_site_id!))];

  const [merchants, sites] = await Promise.all([
    merchantIds.length > 0
      ? prisma.user_merchants.findMany({
          where: { id: { in: merchantIds } },
          select: { id: true, merchant_name: true, merchant_id: true },
        })
      : [],
    siteIds.length > 0
      ? prisma.publish_sites.findMany({
          where: { id: { in: siteIds } },
          select: { id: true, site_name: true, domain: true, article_html_pattern: true },
        })
      : [],
  ]);

  const merchantMap = new Map(merchants.map((m) => [String(m.id), m]));
  const siteMap = new Map(sites.map((s) => [String(s.id), s]));

  // 组装返回数据，回补缺失的 published_url
  const urlFixOps: Promise<unknown>[] = [];
  const enrichedArticles = articles.map((a) => {
    const merchant = a.user_merchant_id ? merchantMap.get(String(a.user_merchant_id)) : null;
    const site = a.publish_site_id ? siteMap.get(String(a.publish_site_id)) : null;

    let publishedUrl = a.published_url;
    if (!publishedUrl && a.status === "published" && site?.domain && a.slug) {
      const pattern = (site as any).article_html_pattern || "article.html?title={slug}";
      publishedUrl = `https://${site.domain}/${pattern.replace("{slug}", a.slug)}`;
      urlFixOps.push(prisma.articles.update({ where: { id: a.id }, data: { published_url: publishedUrl } }));
    }

    return {
      ...a,
      published_url: publishedUrl,
      merchant_name: a.merchant_name || merchant?.merchant_name || null,
      merchant_id: merchant?.merchant_id || null,
      site_name: site?.site_name || null,
      site_domain: site?.domain || null,
    };
  });
  if (urlFixOps.length > 0) Promise.all(urlFixOps).catch(() => {});

  return apiSuccess(serializeData({ articles: enrichedArticles, total, page, pageSize }));
}

// 创建文章并触发 AI 生成（文章发布页手动流程）
export async function POST(req: NextRequest) {
  const user = getUserFromRequest(req);
  if (!user) return apiError("未授权", 401);

  const { user_merchant_id, language, country, images, crawl_data } = await req.json();
  if (!user_merchant_id) return apiError("缺少商家 ID");

  const userId = BigInt(user.userId);

  const merchant = await prisma.user_merchants.findFirst({
    where: { id: BigInt(user_merchant_id), user_id: userId, is_deleted: 0 },
  });
  if (!merchant) return apiError("商家不存在");

  // 追踪链接优先 campaign_link
  const trackingLink = merchant.campaign_link || merchant.tracking_link || merchant.merchant_url || "";

  // 自动推导发布站点
  let publishSiteId: bigint | null = null;
  try {
    const conn = await prisma.platform_connections.findFirst({
      where: { user_id: userId, platform: merchant.platform, is_deleted: 0, publish_site_id: { not: null } },
    });
    if (conn?.publish_site_id) publishSiteId = conn.publish_site_id;
    if (!publishSiteId) {
      const site = await prisma.publish_sites.findFirst({
        where: { is_deleted: 0, status: "active", verified: 1 },
        select: { id: true },
      });
      if (site) publishSiteId = site.id;
    }
  } catch { /* ignore */ }

  // 创建文章记录
  const article = await prisma.articles.create({
    data: {
      user_id: userId,
      user_merchant_id: BigInt(user_merchant_id),
      publish_site_id: publishSiteId,
      language: language || "en",
      status: "generating",
      merchant_name: merchant.merchant_name,
      tracking_link: trackingLink,
      images: images && images.length > 0 ? images : undefined,
    },
  });

  // 异步生成文章
  (async () => {
    try {
      const { analyzeUrl, generateMerchantArticle } = await import("@/lib/article-gen");

      const targetUrl = merchant.merchant_url || `https://${(merchant.merchant_name || "").toLowerCase().replace(/\s+/g, "")}.com`;
      const analysis = await analyzeUrl(targetUrl, country || "US");

      const title = analysis.titles[0]?.titleEn || analysis.titles[0]?.title || `${merchant.merchant_name} Review`;

      const result = await generateMerchantArticle({
        title,
        merchantName: analysis.brandName || merchant.merchant_name,
        merchantUrl: merchant.merchant_url || "",
        trackingLink,
        country: country || "US",
        products: analysis.products,
        sellingPoints: crawl_data?.selling_points?.length > 0 ? crawl_data.selling_points : analysis.sellingPoints,
        keywords: analysis.keywords,
        images: images || [],
        userId,
      });

      await prisma.articles.update({
        where: { id: article.id },
        data: {
          title,
          slug: title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, ""),
          content: result.content,
          excerpt: result.excerpt,
          meta_title: result.metaTitle,
          meta_description: result.metaDescription,
          keywords: analysis.keywords as any,
          category: result.category || analysis.category || "General",
          status: "preview",
        },
      });
    } catch (err) {
      console.error("[ArticleCreate] 文章生成失败:", err);
      try {
        await prisma.articles.update({
          where: { id: article.id },
          data: { status: "failed" },
        });
      } catch { /* ignore */ }
    }
  })();

  return apiSuccess(serializeData({ id: article.id }), "文章生成已启动");
}

// 更新文章（编辑标题/内容/选择发布站点）
export async function PUT(req: NextRequest) {
  const user = getUserFromRequest(req);
  if (!user) return apiError("未授权", 401);

  const { id, title, content, keywords, publish_site_id, status } = await req.json();
  if (!id) return apiError("缺少文章 ID");

  const article = await prisma.articles.findFirst({
    where: { id: BigInt(id), user_id: BigInt(user.userId), is_deleted: 0 },
  });
  if (!article) return apiError("文章不存在");

  const data: Record<string, unknown> = {};
  if (title !== undefined) data.title = title;
  if (content !== undefined) data.content = content;
  if (keywords !== undefined) data.keywords = keywords;
  if (publish_site_id !== undefined) data.publish_site_id = publish_site_id ? BigInt(publish_site_id) : null;
  if (status !== undefined) {
    data.status = status;
    if (status === "published") data.published_at = new Date();
  }

  await prisma.articles.update({ where: { id: BigInt(id) }, data });
  return apiSuccess(null, "更新成功");
}

// 删除文章（单个或批量清理失败文章）
export async function DELETE(req: NextRequest) {
  const user = getUserFromRequest(req);
  if (!user) return apiError("未授权", 401);

  const body = await req.json();

  // 批量清理失败/生成中的文章
  if (body.action === "cleanup_failed") {
    const result = await prisma.articles.updateMany({
      where: {
        user_id: BigInt(user.userId),
        status: { in: ["failed", "generating"] },
        is_deleted: 0,
      },
      data: { is_deleted: 1 },
    });
    return apiSuccess({ cleaned: result.count }, `已清理 ${result.count} 篇失败文章`);
  }

  const { id } = body;
  if (!id) return apiError("缺少文章 ID");

  await prisma.articles.update({
    where: { id: BigInt(id) },
    data: { is_deleted: 1 },
  });
  return apiSuccess(null, "删除成功");
}
