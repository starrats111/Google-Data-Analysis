// ───────────────────────────────────────────────────────────────
// D-091：SemRush「自然词池 + 付费词池 → AI 池内选词」共享流水线
//
// 原先此逻辑内联在 POST /api/user/ad-creation/semrush。D-091 抽成共享 helper，
// 供两处复用：
//   1) /semrush 路由（手动/兜底拉关键词，行为不变）
//   2) 广告生成 core 任务（与爬虫并发跑，复用同一次 queryDomain，避免二次查询/设备数超限）
//
// 含：24h 缓存兜底 + 错误分类 + 路由层重试（I3 / I6 / I7），与原实现一致。
// ───────────────────────────────────────────────────────────────

import { SemRushClient, normalizeDomain } from "@/lib/semrush-client";
import { selectKeywordsWithAi, type SelectedKeyword } from "@/lib/keyword-selector";
import prisma from "@/lib/prisma";

const CACHE_TTL_HOURS = 24;
const OUTER_RETRY_DELAY_MS = 5000;

/** country → SemRush database 码（与 semrush-client.ts D-083 COUNTRY_EXCEPTIONS 保持一致） */
export function countryToDb(country?: string): string {
  if (!country) return "us";
  const EXCEPTIONS: Record<string, string> = {
    GB: "uk", UK: "uk", IE: "uk",
    AT: "de", CH: "de", "BE-FR": "be",
    NZ: "au",
    HK: "sg", TW: "sg", MY: "sg", ID: "sg",
    TH: "us", VN: "us",
    AE: "sa",
  };
  const upper = country.toUpperCase();
  if (EXCEPTIONS[upper]) return EXCEPTIONS[upper];
  const lower = upper.toLowerCase();
  const KNOWN = new Set(["us","uk","ca","au","de","fr","es","it","pt","br","nl","jp","be","se","no","dk","fi","pl","ru","in","sg","mx","ar","cl","co","tr","il","sa","kr","gr","ro","cz","hu","bg"]);
  return KNOWN.has(lower) ? lower : "us";
}

/** 根据错误信息归类，决定前端 UI 表现 + 是否走缓存兜底 */
export function classifyError(err: unknown): { category: string; userMessage: string; canFallbackToCache: boolean } {
  const msg = err instanceof Error ? err.message : String(err ?? "");
  if (msg.includes("凭据未配置")) {
    return {
      category: "config_missing",
      userMessage: "SemRush 功能未配置，请联系管理员在后台设置 3UE 凭据",
      canFallbackToCache: false,
    };
  }
  if (msg.includes("账户认证失败") || msg.includes("账户访问被拒绝") || msg.includes("账户已过期") || msg.includes("API Key 无效")) {
    return {
      category: "account_blocked",
      userMessage: "3UE 账户异常（已通知管理员处理），请稍后或粘贴 3UE 链接手动获取",
      canFallbackToCache: true,
    };
  }
  if (msg.includes("请求过于频繁") || msg.includes("429")) {
    return {
      category: "3ue_unstable",
      userMessage: "3UE 请求过于频繁，已自动限流，请稍后重试",
      canFallbackToCache: true,
    };
  }
  // FIX-NODE-LIMIT：节点配额耗尽（系统已自动切节点仍失败）。区别于「该商家无数据(no_data)」，
  // 必须明确提示是额度问题，否则会误以为商家无数据而手动填词。
  if (/额度|配额|limits?\s*exceeded/i.test(msg)) {
    return {
      category: "quota_exceeded",
      userMessage: "SemRush 节点今日额度已用尽（系统已尝试自动切换节点）。请稍后重试，或在管理后台切换 3UE 节点 / 升级套餐",
      canFallbackToCache: true,
    };
  }
  if (
    msg.includes("3UE 服务暂时不可用") ||
    msg.includes("3UE 服务器内部错误") ||
    msg.includes("3UE 返回空响应") ||
    msg.includes("3UE 服务返回了不完整的数据") ||
    msg.includes("超时")
  ) {
    return {
      category: "3ue_unstable",
      userMessage: "3UE 第三方服务暂时不稳定，请稍后重试或粘贴 3UE 链接手动获取",
      canFallbackToCache: true,
    };
  }
  return {
    category: "unknown",
    userMessage: msg || "SemRush 查询失败，请稍后再试",
    canFallbackToCache: true,
  };
}

/** 一次完整的 SemRush 拉取 + AI 池内选词 pipeline（不含外层重试 / 缓存兜底） */
async function runOnePipeline(
  merchantUrl: string,
  country: string,
  merchantName: string,
  dailyBudgetUsd: number,
  maxCpcUsd: number,
  userId?: string | number | bigint,
) {
  // 方案-09：有 userId → 优先用员工自配账号（无则内部回退全局）；无 userId → 直接全局。
  const client = userId != null
    ? await SemRushClient.fromUserConfig(userId, country)
    : await SemRushClient.fromConfig(country);
  const result = await client.queryDomain(merchantUrl);
  const domain = result.domain;

  // D-047: AI 从「自然词池(organic) + 付费词池(paid)」里选词（只选不造）
  const allKeywords = await selectKeywordsWithAi(result.keywords, result.paidKeywords, {
    merchantName,
    domain,
    dailyBudgetUsd,
    maxCpcUsd,
  });

  return {
    domain: result.domain,
    deduped_titles: result.dedupedTitles,
    deduped_descriptions: result.dedupedDescriptions,
    keywords: allKeywords,
    raw_keyword_count: result.keywords.length,
    paid_keyword_count: result.paidKeywords.length,
    total_copies: result.copies.total,
    creative_samples_count: result.creativeSamples.length,
  };
}

/** D-038c-v2 I6：写入 24h 缓存（异步 fire-and-forget，失败不影响主流程） */
async function writeCache(domain: string, db: string, payload: object, rawKwCnt: number) {
  try {
    const now = new Date();
    const expiresAt = new Date(now.getTime() + CACHE_TTL_HOURS * 60 * 60 * 1000);
    const serialized = JSON.stringify(payload);
    await prisma.semrush_keyword_cache.upsert({
      where: { domain_database: { domain, database: db } },
      update: { payload: serialized, raw_kw_cnt: rawKwCnt, cached_at: now, expires_at: expiresAt },
      create: { domain, database: db, payload: serialized, raw_kw_cnt: rawKwCnt, cached_at: now, expires_at: expiresAt },
    });
  } catch (err) {
    console.warn("[SemRush Cache] 写入失败（忽略，不影响主流程）:", err instanceof Error ? err.message : err);
  }
}

/** D-038c-v2 I6：读取 24h 缓存（pipeline 失败时兜底用） */
async function readCache(domain: string, db: string): Promise<{ payload: Record<string, unknown>; cacheAgeHours: number } | null> {
  try {
    const cached = await prisma.semrush_keyword_cache.findUnique({
      where: { domain_database: { domain, database: db } },
    });
    if (!cached) return null;
    const now = new Date();
    if (cached.expires_at < now) return null;
    const cacheAgeMs = now.getTime() - cached.cached_at.getTime();
    const cacheAgeHours = Math.max(0, Math.round((cacheAgeMs / (60 * 60 * 1000)) * 10) / 10);
    const payload = JSON.parse(cached.payload) as Record<string, unknown>;
    return { payload, cacheAgeHours };
  } catch (err) {
    console.warn("[SemRush Cache] 读取失败:", err instanceof Error ? err.message : err);
    return null;
  }
}

export interface SemrushKeywordsParams {
  merchantUrl: string;
  country: string;
  merchantName: string;
  dailyBudgetUsd: number;
  maxCpcUsd: number;
  /** 方案-09：发起广告生成的员工 ID，用于选用其自配 SemRush 账号（缺省回退全局） */
  userId?: string | number | bigint;
}

export interface SemrushKeywordsResult {
  ok: boolean;
  /** 成功/缓存命中时的完整 data 对象（snake_case），供 /semrush 路由原样下发 */
  payload: Record<string, unknown> | null;
  keywords: SelectedKeyword[];
  dedupedTitles: string[];
  dedupedDescriptions: string[];
  fromCache: boolean;
  cacheAgeHours: number;
  errorCategory: string | null;
  errorMessage: string;
}

/**
 * 完整的 SemRush 关键词流水线：主跑 + I7 路由层重试 + I6 缓存兜底 + 错误分类。
 * 永不抛错——失败返回 ok:false + 分类信息，调用方自行决定 UI / 降级。
 */
export async function fetchSemrushKeywords(params: SemrushKeywordsParams): Promise<SemrushKeywordsResult> {
  const { merchantUrl, country, merchantName, dailyBudgetUsd, maxCpcUsd, userId } = params;
  const normalized = normalizeDomain(merchantUrl);
  const db = countryToDb(country);

  let firstErr: unknown = null;
  try {
    const data = await runOnePipeline(merchantUrl, country, merchantName, dailyBudgetUsd, maxCpcUsd, userId);
    void writeCache(normalized, db, data, data.raw_keyword_count);
    return {
      ok: true,
      payload: data,
      keywords: data.keywords,
      dedupedTitles: data.deduped_titles,
      dedupedDescriptions: data.deduped_descriptions,
      fromCache: false,
      cacheAgeHours: 0,
      errorCategory: null,
      errorMessage: "",
    };
  } catch (err) {
    firstErr = err;
    const cls = classifyError(err);
    console.warn(`[SemRush] 首次失败 (category=${cls.category}): ${err instanceof Error ? err.message : err}`);
    // account_blocked / config_missing 不重试（无意义）
    if (cls.category !== "account_blocked" && cls.category !== "config_missing") {
      await new Promise((r) => setTimeout(r, OUTER_RETRY_DELAY_MS));
      try {
        console.log(`[SemRush] I7 路由层重试 1/1（已等待 ${OUTER_RETRY_DELAY_MS}ms）`);
        const data = await runOnePipeline(merchantUrl, country, merchantName, dailyBudgetUsd, maxCpcUsd, userId);
        void writeCache(normalized, db, data, data.raw_keyword_count);
        return {
          ok: true,
          payload: data,
          keywords: data.keywords,
          dedupedTitles: data.deduped_titles,
          dedupedDescriptions: data.deduped_descriptions,
          fromCache: false,
          cacheAgeHours: 0,
          errorCategory: null,
          errorMessage: "",
        };
      } catch (err2) {
        firstErr = err2;
        console.warn(`[SemRush] I7 重试仍失败: ${err2 instanceof Error ? err2.message : err2}`);
      }
    }
  }

  // ─── I6 缓存兜底 ───
  const cls = classifyError(firstErr);
  if (cls.canFallbackToCache) {
    const cacheHit = await readCache(normalized, db);
    if (cacheHit) {
      console.log(`[SemRush] 命中 24h 缓存兜底 domain=${normalized} db=${db} age=${cacheHit.cacheAgeHours}h`);
      const p = cacheHit.payload;
      return {
        ok: true,
        payload: p,
        keywords: (p.keywords as SelectedKeyword[]) ?? [],
        dedupedTitles: (p.deduped_titles as string[]) ?? [],
        dedupedDescriptions: (p.deduped_descriptions as string[]) ?? [],
        fromCache: true,
        cacheAgeHours: cacheHit.cacheAgeHours,
        errorCategory: "cache_fallback",
        errorMessage: cls.userMessage,
      };
    }
  }

  console.error(`[SemRush] 最终失败 category=${cls.category} domain=${normalized}: ${cls.userMessage}`);
  return {
    ok: false,
    payload: null,
    keywords: [],
    dedupedTitles: [],
    dedupedDescriptions: [],
    fromCache: false,
    cacheAgeHours: 0,
    errorCategory: cls.category,
    errorMessage: cls.userMessage,
  };
}
