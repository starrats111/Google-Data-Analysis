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
// 速度病灶修复：300s → 180s。路由层 runCrawlWithSafety 的预算约 165s，桥接层给 300s 意味着
// 同一请求里第二轮爬取比第一轮还能多挂 135s——第一轮全策略瀑布都失败的站，第二轮同样失败，
// 多出来的预算纯属排队烧时间。180s 足够跑完整个策略瀑布。
const CRAWL_HANG_SAFETY_MS = 180_000;
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
  /**
   * 速度病灶修复（同请求三轮爬取 → 一轮）：调用方（generate-extensions 路由层）在本次请求里
   * 刚刚跑完自己的爬取/刷新逻辑时传 true——existingCache 就是几秒前的最新结果，哪怕它是
   * crawlFailed 空壳（说明该站全策略瀑布刚失败过），立刻原样重爬一遍也只会再烧 165-300s 后
   * 同样失败。此时无条件信任传入缓存，不再触发第二/三轮重爬。
   */
  trustExistingCache?: boolean;
  /**
   * 桥接层真的爬了新数据时回调落库（审计病灶 #4：orchestrator 重爬结果此前只活在内存里，
   * 下个请求看到的还是 DB 里的旧缓存，同一个站被反复重爬）。
   */
  persist?: (cache: CrawlCache) => Promise<void>;
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

  // 见 trustExistingCache 字段注释：路由层刚爬完，无条件复用，杜绝同请求重复爬取
  if (!ctx.forceRefresh && ctx.trustExistingCache && cached) {
    return {
      cache: cached,
      cacheHit: true,
      elapsedMs: Date.now() - startedAt,
    };
  }

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
    // 重爬结果落库（不阻断主流程）；空壳失败结果不覆盖已有好缓存
    if (ctx.persist && !newCache.crawlFailed) {
      await ctx.persist(newCache).catch((e) =>
        console.warn(`[CrawlerBridge] 重爬结果落库失败（不阻断）: ${e instanceof Error ? e.message : e}`),
      );
    }
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
