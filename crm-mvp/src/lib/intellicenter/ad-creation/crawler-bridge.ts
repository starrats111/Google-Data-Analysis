/**
 * C-112 / D-046.C — Step 2：商家实时爬虫触发桥
 *
 * 不重写爬虫 — 直接复用 lib/crawl-pipeline.ts 已有的 buildCrawlCache（D-038b 已稳定 91.7% 成功率）。
 * 本文件只做：
 *   - 缓存命中判断（ad_creatives.crawl_cache 已有 + 不超过 7 天 + 质量分≥40 → 复用）
 *   - 必要时调 buildCrawlCache 重爬
 *   - 把 CrawlCache → ProfileGenerationContext.crawl + EvidenceContext 统一适配
 *
 * 设计目标：让 orchestrator 不关心爬虫细节，只看"我需要这商家的爬虫数据"即可。
 */

import {
  type CrawlCache,
  buildCrawlCache,
} from "@/lib/crawl-pipeline";
import {
  buildCrawlKey,
  withCrawlInflightLock,
} from "@/lib/crawl-inflight-lock";

const CACHE_FRESHNESS_DAYS = 7;
const CRAWL_HANG_SAFETY_MS = 300_000; // 5 分钟 hang 兜底（与 generate-extensions 现行一致）
const LOCK_TIMEOUT_MS = CRAWL_HANG_SAFETY_MS + 10_000;

export interface CrawlerBridgeContext {
  merchantUrl: string;
  merchantName: string;
  targetCountry: string;
  /** 已有的 ad_creatives.crawl_cache（命中时复用） */
  existingCache?: CrawlCache | null;
  /** 强制重爬（07 编辑 URL 或员工点"重新爬取"时传 true） */
  forceRefresh?: boolean;
  /** 强制使用 puppeteer 而非 fetch 抓（promotion 需求时传 true） */
  forcePuppeteer?: boolean;
}

export interface CrawlerBridgeResult {
  cache: CrawlCache;
  /** 是否命中缓存（true = 没调爬虫直接复用） */
  cacheHit: boolean;
  /** crawl 总耗时 ms */
  elapsedMs: number;
  /** 失败时填，调用方应该走降级路径（不阻断广告创建，但 evidence 块会标"crawl failed"） */
  error?: string;
}

export async function ensureCrawlCache(
  ctx: CrawlerBridgeContext,
): Promise<CrawlerBridgeResult> {
  const startedAt = Date.now();
  const cached = ctx.existingCache;

  if (!ctx.forceRefresh && cached && cached.crawledAt && !cached.crawlFailed) {
    const ageMs =
      Date.now() - new Date(cached.crawledAt as unknown as string).getTime();
    const ageDays = ageMs / (1000 * 60 * 60 * 24);
    const score = typeof cached.crawlQualityScore === "number" ? cached.crawlQualityScore : 100;
    const pageTextLen = (cached.pageText ?? "").length;
    const goodEnough =
      ageDays <= CACHE_FRESHNESS_DAYS &&
      score >= 40 &&
      pageTextLen >= 200;
    if (goodEnough) {
      return {
        cache: cached,
        cacheHit: true,
        elapsedMs: Date.now() - startedAt,
      };
    }
  }

  const key = buildCrawlKey(ctx.merchantUrl, ctx.targetCountry);
  try {
    const newCache = await withCrawlInflightLock(
      key,
      async () => {
        const hangSafety = new Promise<CrawlCache>((_, reject) =>
          setTimeout(
            () => reject(new Error("buildCrawlCache-hang-safety")),
            CRAWL_HANG_SAFETY_MS,
          ).unref?.(),
        );
        const result = await Promise.race([
          buildCrawlCache(
            ctx.merchantUrl,
            ctx.merchantName,
            ctx.targetCountry,
            undefined,
            { forcePuppeteer: ctx.forcePuppeteer === true },
          ),
          hangSafety,
        ]);
        return result;
      },
      LOCK_TIMEOUT_MS,
    );
    return {
      cache: newCache,
      cacheHit: false,
      elapsedMs: Date.now() - startedAt,
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      cache: cached ?? createEmptyCache(ctx.merchantUrl),
      cacheHit: false,
      elapsedMs: Date.now() - startedAt,
      error: msg,
    };
  }
}

function createEmptyCache(url: string): CrawlCache {
  return {
    crawlFailed: true,
    crawlMethod: "failed",
    crawlQualityScore: 0,
    crawlQualityIssues: ["crawler_bridge_emergency_fallback"],
    crawledAt: new Date().toISOString(),
    pageText: "",
    title: "",
    metaDescription: "",
    finalUrl: url,
    links: [],
    images: [],
    features: [],
    semrushTitles: [],
    sitelinkCandidates: [],
  } as unknown as CrawlCache;
}
