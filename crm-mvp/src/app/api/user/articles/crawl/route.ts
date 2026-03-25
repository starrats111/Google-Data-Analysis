import { NextRequest } from "next/server";
import { getUserFromRequest } from "@/lib/auth";
import { apiSuccess, apiError } from "@/lib/constants";
import { getBackendConfig } from "@/lib/system-config";

// 整个爬取流程的总超时（55 秒，留 5 秒给响应序列化）
const CRAWL_TOTAL_TIMEOUT_MS = 55_000;

/**
 * POST /api/user/articles/crawl
 * 爬取商家网站信息和图片
 * 优先调用后端 Python 爬虫，失败则用 CRM 本地爬虫兜底
 */
export async function POST(req: NextRequest) {
  try {
    const user = getUserFromRequest(req);
    if (!user) return apiError("未授权", 401);

    let body: Record<string, unknown>;
    try {
      body = await req.json();
    } catch {
      return apiError("请求体解析失败", 400);
    }

    const { merchant_id, merchant_url, merchant_name, country } = body as {
      merchant_id?: string;
      merchant_url?: string;
      merchant_name?: string;
      country?: string;
    };
    if (!merchant_id) return apiError("缺少商家 ID");

    // 总超时控制：防止爬取流程卡死导致请求挂起
    const totalAbort = new AbortController();
    const totalTimer = setTimeout(() => totalAbort.abort(), CRAWL_TOTAL_TIMEOUT_MS);

    try {
      const result = await doCrawl({
        merchantUrl: merchant_url,
        merchantName: merchant_name || "",
        country: country || "US",
        signal: totalAbort.signal,
      });
      return apiSuccess(result);
    } finally {
      clearTimeout(totalTimer);
    }
  } catch (err) {
    console.error("[ArticleCrawl] 未捕获异常:", err);
    // 即使出错也返回空结果而非 500，让前端走"未获取到图片"的正常流程
    return apiSuccess({
      images: [],
      title: "",
      description: "",
      selling_points: [],
    });
  }
}

async function doCrawl(opts: {
  merchantUrl?: string;
  merchantName: string;
  country: string;
  signal: AbortSignal;
}) {
  const { merchantUrl, merchantName, country, signal } = opts;

  // ── 1. 优先调用后端 Python 爬虫 ──
  let backendConfig: { apiUrl: string; apiToken: string } | null = null;
  try {
    backendConfig = await getBackendConfig();
  } catch (err) {
    console.warn("[ArticleCrawl] 读取后端配置失败:", err);
  }

  if (backendConfig?.apiUrl) {
    try {
      const headers: Record<string, string> = { "Content-Type": "application/json" };
      if (backendConfig.apiToken) headers["Authorization"] = `Bearer ${backendConfig.apiToken}`;

      const crawlUrl = `${backendConfig.apiUrl}/api/luchu/analyze-merchant`;
      const res = await fetch(crawlUrl, {
        method: "POST",
        headers,
        body: JSON.stringify({
          merchant_url: merchantUrl || "",
          merchant_name: merchantName,
          country,
        }),
        signal: AbortSignal.any([signal, AbortSignal.timeout(30_000)]),
      });

      if (res.ok) {
        const data = await res.json();
        const images = data.data?.images || data.images || [];
        if (images.length > 0) {
          return {
            images,
            title: data.data?.title || data.title || merchantName || "",
            description: data.data?.description || data.description || "",
            selling_points: data.data?.selling_points || data.selling_points || [],
          };
        }
      }
    } catch (err) {
      if (signal.aborted) throw err; // 总超时，直接抛出
      console.error("[ArticleCrawl] 后端爬取失败，使用本地爬虫:", err);
    }
  }

  // ── 2. 本地爬虫兜底 ──
  const targetUrl = merchantUrl || `https://${merchantName.toLowerCase().replace(/\s+/g, "")}.com`;
  let images: string[] = [];
  let title = merchantName || "";
  let description = "";
  const sellingPoints: string[] = [];

  try {
    if (signal.aborted) throw new Error("crawl aborted");

    const { crawlPage, fetchPageImages, searchMerchantImages, extractPageMeta } = await import("@/lib/crawler");

    const [crawlResult, pageImgs, searchImgs] = await Promise.allSettled([
      crawlPage(targetUrl),
      fetchPageImages(targetUrl),
      searchMerchantImages(targetUrl, merchantName),
    ]);

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

    if (pageImgs.status === "fulfilled" && pageImgs.value?.length > 0) {
      const newImgs = pageImgs.value.filter((img: string) => !images.includes(img));
      images.push(...newImgs);
    }

    if (searchImgs.status === "fulfilled" && searchImgs.value?.length > 0) {
      const newImgs = searchImgs.value.filter((img: string) => !images.includes(img));
      images.push(...newImgs);
    }

    images = [...new Set(images)].slice(0, 20);
  } catch (err) {
    console.error("[ArticleCrawl] 本地爬取也失败:", err);
  }

  return {
    images,
    title,
    description,
    selling_points: sellingPoints,
  };
}
