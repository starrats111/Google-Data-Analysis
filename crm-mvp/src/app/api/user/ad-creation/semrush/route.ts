import { NextRequest } from "next/server";
import { getUserFromRequest, serializeData } from "@/lib/auth";
import { apiError } from "@/lib/constants";
import { SemRushClient, normalizeDomain } from "@/lib/semrush-client";
import { selectKeywordsWithAi } from "@/lib/keyword-selector";
import { prisma } from "@/lib/prisma";

/**
 * POST /api/user/ad-creation/semrush
 * 关键词来源（D-047 / C-113）：SemRush「自然词池 + 付费词池」，由 AI 在真实池内「选词」
 * （只选不造，付费优先 + 自然补长尾，数量按预算 / CPC 自适应，match type 三因子）。
 *
 * D-038c-v2 路由层增强（I3 / I6 / I7）：
 *   - I3 errorCategory：错误分类（3ue_unstable / session_expired / account_blocked / config_missing / cache_fallback / unknown）
 *   - I6 cache 兜底：成功后 24h TTL 写入 semrush_keyword_cache；I5+I7 都失败时回退读缓存（黄色 toast 提示）
 *   - I7 路由层重试：fromConfig→queryDomain pipeline 整体失败时延迟 5s 重试 1 次
 */

const CACHE_TTL_HOURS = 24;
const OUTER_RETRY_DELAY_MS = 5000;

/** country → SemRush database 码（与 semrush-client.ts countryToDatabase 内部逻辑保持一致） */
function countryToDb(country?: string): string {
  if (!country) return "us";
  const upper = country.toUpperCase();
  if (upper === "GB" || upper === "UK") return "uk";
  return upper.toLowerCase();
}

/** 根据错误信息归类，决定前端 UI 表现 + 是否走缓存兜底 */
function classifyError(err: unknown): { category: string; userMessage: string; canFallbackToCache: boolean } {
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
) {
  const client = await SemRushClient.fromConfig(country);
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

export async function POST(req: NextRequest) {
  const user = getUserFromRequest(req);
  if (!user) return apiError("未授权", 401);

  let merchantUrl = "";
  let country = "US";
  let merchantName = "";
  let dailyBudgetUsd = 2;
  let maxCpcUsd = 0.3;
  try {
    const body = await req.json();
    merchantUrl = String(body.merchant_url || "");
    country = String(body.country || "US");
    merchantName = String(body.merchant_name || "");
    dailyBudgetUsd = Number(body.daily_budget) > 0 ? Number(body.daily_budget) : 2;
    maxCpcUsd = Number(body.max_cpc) > 0 ? Number(body.max_cpc) : 0.3;
  } catch {
    return apiError("请求参数格式错误");
  }
  if (!merchantUrl) return apiError("缺少商家 URL");

  const normalized = normalizeDomain(merchantUrl);
  const db = countryToDb(country);

  // ─── pipeline 主流程 + I7 路由层重试 ───
  let firstErr: unknown = null;
  try {
    const data = await runOnePipeline(merchantUrl, country, merchantName, dailyBudgetUsd, maxCpcUsd);
    // 异步写缓存，不 await
    void writeCache(normalized, db, data, data.raw_keyword_count);
    return Response.json({
      code: 0,
      message: "success",
      data: serializeData({ ...data, from_cache: false, error_category: null }),
    });
  } catch (err) {
    firstErr = err;
    const cls = classifyError(err);
    console.warn(`[SemRush API] 首次失败 (category=${cls.category}): ${err instanceof Error ? err.message : err}`);
    // account_blocked / config_missing 不重试（无意义）
    if (cls.category === "account_blocked" || cls.category === "config_missing") {
      // 直接跳到缓存兜底判断
    } else {
      // I7：延迟 5s 重试 1 次
      await new Promise((r) => setTimeout(r, OUTER_RETRY_DELAY_MS));
      try {
        console.log(`[SemRush API] I7 路由层重试 1/1（已等待 ${OUTER_RETRY_DELAY_MS}ms）`);
        const data = await runOnePipeline(merchantUrl, country, merchantName, dailyBudgetUsd, maxCpcUsd);
        void writeCache(normalized, db, data, data.raw_keyword_count);
        return Response.json({
          code: 0,
          message: "success",
          data: serializeData({ ...data, from_cache: false, error_category: null }),
        });
      } catch (err2) {
        firstErr = err2;
        console.warn(
          `[SemRush API] I7 重试仍失败: ${err2 instanceof Error ? err2.message : err2}`,
        );
      }
    }
  }

  // ─── I6 缓存兜底 ───
  const cls = classifyError(firstErr);
  if (cls.canFallbackToCache) {
    const cacheHit = await readCache(normalized, db);
    if (cacheHit) {
      console.log(
        `[SemRush API] 命中 24h 缓存兜底 domain=${normalized} db=${db} age=${cacheHit.cacheAgeHours}h`,
      );
      return Response.json({
        code: 0,
        message: "success_from_cache",
        data: serializeData({
          ...cacheHit.payload,
          from_cache: true,
          cache_age_hours: cacheHit.cacheAgeHours,
          error_category: "cache_fallback",
          error_message: cls.userMessage,
        }),
      });
    }
  }

  console.error(`[SemRush API] 最终失败 category=${cls.category} domain=${normalized}: ${cls.userMessage}`);
  return Response.json(
    { code: -1, message: cls.userMessage, data: { error_category: cls.category } },
    { status: 400 },
  );
}
