import { NextRequest } from "next/server";
import { getUserFromRequest, serializeData } from "@/lib/auth";
import { apiSuccess, apiError } from "@/lib/constants";
import prisma from "@/lib/prisma";
import { getBackendConfig } from "@/lib/system-config";

/**
 * POST /api/user/articles/sync
 * 从数据分析平台后端同步文章数据到 CRM
 */
export async function POST(req: NextRequest) {
  const user = getUserFromRequest(req);
  if (!user) return apiError("未授权", 401);

  const userId = BigInt(user.userId);
  const backendConfig = await getBackendConfig();

  if (!backendConfig.apiUrl) {
    return apiError("未配置后端 API 地址，请在系统配置中设置", 400);
  }

  try {
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (backendConfig.apiToken) headers["Authorization"] = `Bearer ${backendConfig.apiToken}`;

    // 从后端拉取文章列表
    const listUrl = `${backendConfig.apiUrl}/api/articles?page=1&per_page=200&status=published`;
    const res = await fetch(listUrl, { headers, signal: AbortSignal.timeout(30000) });

    if (!res.ok) {
      return apiError(`后端 API 返回 ${res.status}`, 500);
    }

    const data = await res.json();
    const articles = data.data?.articles || data.data?.items || data.articles || data.items || [];

    if (!Array.isArray(articles) || articles.length === 0) {
      return apiSuccess({ synced: 0, message: "后端无文章数据可同步" });
    }

    // 获取用户的商家映射
    const userMerchants = await prisma.user_merchants.findMany({
      where: { user_id: userId, is_deleted: 0 },
      select: { id: true, merchant_id: true, merchant_name: true },
    });
    const merchantNameMap = new Map(
      userMerchants.map((m) => [m.merchant_name?.toLowerCase(), m])
    );

    // 获取站点映射
    const publishSites = await prisma.publish_sites.findMany({
      where: { is_deleted: 0, status: "active" },
      select: { id: true, domain: true, site_name: true },
    });
    const siteDomainMap = new Map(
      publishSites.map((s) => [s.domain?.toLowerCase(), s])
    );

    // 获取已有文章的 slug 集合（避免重复）
    const existingSlugs = await prisma.articles.findMany({
      where: { user_id: userId, is_deleted: 0 },
      select: { slug: true },
    });
    const slugSet = new Set(existingSlugs.map((a) => a.slug).filter(Boolean));

    let synced = 0;
    let skipped = 0;

    for (const article of articles) {
      const title = article.title || "";
      const slug = article.slug || title.toLowerCase().replace(/[^\w\s-]/g, "").replace(/[\s_-]+/g, "-").replace(/^-+|-+$/g, "");

      // 跳过已存在的文章
      if (slug && slugSet.has(slug)) {
        skipped++;
        continue;
      }

      // 匹配商家
      const merchantName = article.merchant_name || "";
      const merchant = merchantNameMap.get(merchantName.toLowerCase());

      // 匹配站点（从发布 URL 提取域名）
      let publishSiteId: bigint | null = null;
      const publishedUrl = article.published_url || article.url || "";
      if (publishedUrl) {
        try {
          const domain = new URL(publishedUrl).hostname.replace(/^www\./, "");
          const site = siteDomainMap.get(domain);
          if (site) publishSiteId = site.id;
        } catch {}
      }

      // 创建文章
      await prisma.articles.create({
        data: {
          user_id: userId,
          user_merchant_id: merchant?.id || null,
          publish_site_id: publishSiteId,
          title: title || null,
          slug: slug || null,
          content: article.content || null,
          excerpt: article.excerpt || null,
          language: article.language || "en",
          keywords: article.meta_keywords ? article.meta_keywords.split(",").map((k: string) => k.trim()) : null,
          images: article.content_images || article.images || null,
          status: article.status === "published" ? "published" : "preview",
          published_at: article.publish_date ? new Date(article.publish_date) : (article.status === "published" ? new Date() : null),
          published_url: publishedUrl || null,
          merchant_name: merchantName || null,
          tracking_link: article.tracking_link || null,
          meta_title: article.meta_title || null,
          meta_description: article.meta_description || null,
        },
      });

      slugSet.add(slug);
      synced++;
    }

    return apiSuccess(serializeData({
      synced,
      skipped,
      message: `同步 ${synced} 篇文章，跳过 ${skipped} 篇已存在`,
    }));
  } catch (err) {
    return apiError(`同步失败: ${err instanceof Error ? err.message : String(err)}`, 500);
  }
}
