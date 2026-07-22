import { NextRequest } from "next/server";
import { apiSuccess, apiError } from "@/lib/constants";
import { verifyHermesToken } from "@/lib/hermes-auth";

// HM-D23：Hermes 委托发文 —— 为指定商家 URL 抓取优质配图候选
// 复用 CRM 本地爬虫（主页 + 子页 HTTP 抓图 + 搜索兜底），出口统一过 isQualityImageUrl。
// Hermes 拿到候选后由 LLM 选 5-8 张嵌入正文；发布时 remote-publisher 会下载并本地化成 /images/articles/*.webp。

const CRAWL_TOTAL_TIMEOUT_MS = 90_000;

export const dynamic = "force-dynamic";
export const maxDuration = 120;

export async function POST(req: NextRequest) {
  const authErr = verifyHermesToken(req);
  if (authErr) return authErr;

  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return apiError("请求体解析失败", 400);
  }

  const { merchant_url, merchant_name } = body as { merchant_url?: string; merchant_name?: string };
  if (!merchant_url || !/^https?:\/\//i.test(merchant_url)) {
    return apiError("merchant_url 必填且须为 http(s) URL");
  }

  const totalAbort = new AbortController();
  const totalTimer = setTimeout(() => totalAbort.abort(), CRAWL_TOTAL_TIMEOUT_MS);

  try {
    const { crawlPage, fetchPageImages, searchMerchantImages, isQualityImageUrl, extractPageMeta } = await import("@/lib/crawler");

    let merchantDomain: string | undefined;
    try { merchantDomain = new URL(merchant_url).hostname; } catch { /* ignore */ }

    const collected: string[] = [];
    const seen = new Set<string>();
    const add = (u: string) => {
      if (!u || seen.has(u)) return;
      if (!isQualityImageUrl(u, merchantDomain)) return;
      seen.add(u);
      collected.push(u);
    };

    let title = merchant_name || "";
    let description = "";
    const links: { url: string; text: string }[] = [];

    const [crawlResult, pageImgs, searchImgs] = await Promise.allSettled([
      crawlPage(merchant_url),
      fetchPageImages(merchant_url),
      searchMerchantImages(merchant_url, merchant_name || ""),
    ]);

    if (crawlResult.status === "fulfilled" && crawlResult.value) {
      for (const img of crawlResult.value.images || []) add(img);
      if (crawlResult.value.links) links.push(...crawlResult.value.links);
      if (crawlResult.value.html) {
        const meta = extractPageMeta(crawlResult.value.html);
        if (meta.title) title = meta.title;
        if (meta.description) description = meta.description;
      }
    }
    if (pageImgs.status === "fulfilled") for (const img of pageImgs.value || []) add(img);

    // 数量不足时抓产品/分类子页补图（目标 ≥15 张候选，Hermes 端好挑）
    if (collected.length < 15 && links.length > 0 && !totalAbort.signal.aborted) {
      const productLinks = links
        .filter((l) => /\/(collection|category|shop|products?|sale|new|all|item|detail)\b/i.test(l.url))
        .slice(0, 6)
        .map((l) => l.url);
      for (const sub of productLinks) {
        if (collected.length >= 30 || totalAbort.signal.aborted) break;
        const imgs = await fetchPageImages(sub).catch(() => [] as string[]);
        for (const img of imgs) add(img);
      }
    }

    // 搜索兜底放最后（相关性最弱）
    if (searchImgs.status === "fulfilled") for (const img of searchImgs.value || []) add(img);

    return apiSuccess({
      images: collected.slice(0, 40),
      title,
      description,
    });
  } catch (err) {
    console.error("[HermesCrawlImages] 异常:", err);
    return apiSuccess({ images: [], title: merchant_name || "", description: "" });
  } finally {
    clearTimeout(totalTimer);
  }
}
