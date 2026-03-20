import { NextRequest } from "next/server";
import { getUserFromRequest } from "@/lib/auth";
import { apiSuccess, apiError } from "@/lib/constants";
import { getBackendConfig } from "@/lib/system-config";

/**
 * POST /api/user/articles/crawl
 * 爬取商家网站信息和图片
 * 优先调用后端 Python 爬虫，失败则用 CRM 本地爬虫兜底
 */
export async function POST(req: NextRequest) {
  const user = getUserFromRequest(req);
  if (!user) return apiError("未授权", 401);

  const { merchant_id, merchant_url, merchant_name, country } = await req.json();
  if (!merchant_id) return apiError("缺少商家 ID");

  const backendConfig = await getBackendConfig();

  // 优先调用后端 Python 爬虫
  if (backendConfig.apiUrl) {
    try {
      const headers: Record<string, string> = { "Content-Type": "application/json" };
      if (backendConfig.apiToken) headers["Authorization"] = `Bearer ${backendConfig.apiToken}`;

      const crawlUrl = `${backendConfig.apiUrl}/api/luchu/analyze-merchant`;
      const res = await fetch(crawlUrl, {
        method: "POST",
        headers,
        body: JSON.stringify({
          merchant_url: merchant_url || "",
          merchant_name: merchant_name || "",
          country: country || "US",
        }),
        signal: AbortSignal.timeout(60000),
      });

      if (res.ok) {
        const data = await res.json();
        const images = data.data?.images || data.images || [];
        if (images.length > 0) {
          return apiSuccess({
            images,
            title: data.data?.title || data.title || merchant_name || "",
            description: data.data?.description || data.description || "",
            selling_points: data.data?.selling_points || data.selling_points || [],
          });
        }
      }
    } catch (err) {
      console.error("[ArticleCrawl] 后端爬取失败，使用本地爬虫:", err);
    }
  }

  // 本地爬虫兜底：使用 CRM 自带的 crawler.ts
  const targetUrl = merchant_url || `https://${(merchant_name || "").toLowerCase().replace(/\s+/g, "")}.com`;
  let images: string[] = [];
  let title = merchant_name || "";
  let description = "";
  let sellingPoints: string[] = [];

  try {
    const { crawlPage, fetchPageImages, searchMerchantImages, extractPageMeta } = await import("@/lib/crawler");

    const [crawlResult, pageImgs, searchImgs] = await Promise.allSettled([
      crawlPage(targetUrl),
      fetchPageImages(targetUrl),
      searchMerchantImages(targetUrl, merchant_name || ""),
    ]);

    // 从 crawlPage 获取图片和页面元信息
    if (crawlResult.status === "fulfilled" && crawlResult.value) {
      if (crawlResult.value.images?.length > 0) {
        images.push(...crawlResult.value.images);
      }
      if (crawlResult.value.html) {
        const meta = extractPageMeta(crawlResult.value.html);
        if (meta.title) title = meta.title;
        if (meta.description) description = meta.description;
      }
    }

    // 从 fetchPageImages 补充
    if (pageImgs.status === "fulfilled" && pageImgs.value?.length > 0) {
      const newImgs = pageImgs.value.filter((img: string) => !images.includes(img));
      images.push(...newImgs);
    }

    // 从 searchMerchantImages 补充
    if (searchImgs.status === "fulfilled" && searchImgs.value?.length > 0) {
      const newImgs = searchImgs.value.filter((img: string) => !images.includes(img));
      images.push(...newImgs);
    }

    images = [...new Set(images)].slice(0, 20);
    console.log(`[ArticleCrawl] 本地爬取完成: ${images.length} 张图片`);
  } catch (err) {
    console.error("[ArticleCrawl] 本地爬取也失败:", err);
  }

  return apiSuccess({
    images,
    title,
    description,
    selling_points: sellingPoints,
  });
}
