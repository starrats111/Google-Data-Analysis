import { NextRequest } from "next/server";
import { apiSuccess, apiError } from "@/lib/constants";
import { verifyHermesToken } from "@/lib/hermes-auth";
import { fetchSemrushKeywords } from "@/lib/semrush-keywords";

// HM-D80 / D-307：Hermes 的广告文案样本与选商家深筛改用 SemRush，停用 SerpApi。
//
// 起因：07「你看看要不要不然就换成 semrush 找关键词」「不要用 serp api 了」。
// SerpApi 是 Production Plan $150/月、15000 次，与 kyads 共享，9-01 已耗尽（续期 9-05）。
//
// ⚠️ 一个容易搞反的点：Hermes 并没有用 SerpApi「找关键词」——它的关键词一直是写死的
// 域名品牌词。SerpApi 在 Hermes 只干两件事：① filter 模式的广告文案原文样本
// （rsa-filter.js，这是默认生成模式，断了就一条广告都建不出来）；② 选商家深筛
// （sop-deep.js，无 key 时本就自动放行）。本接口替代的是这两件事的数据源。
//
// 复用 fetchSemrushKeywords 而不是新写一套：它自带 3UE 会话复用、全局限流、按
// 域名+库缓存、多账号回退、错误分类，且**永不抛错**（失败返回 ok:false）。Hermes 再抄
// 一份就是 D-306 那个「配置副本不同步」的老路。
//
// 一次调用同时喂两个用途（原来要 9 次 SerpApi 查询）：
//   deduped_titles / deduped_descriptions → 文案候选池
//   raw_keyword_count                     → 品牌搜索存在感（深筛，近似替代自然结果判定）
//   paid_keyword_count / total_copies     → 该商家自己在不在投广告
//
// 只读、不写业务库（fetchSemrushKeywords 内部会写它自己的域名缓存表）。

export const dynamic = "force-dynamic";
export const maxDuration = 300; // 3UE 有全局互斥 + 退避重试，单次可达数分钟

export async function POST(req: NextRequest) {
  const denied = verifyHermesToken(req);
  if (denied) return denied;

  let body: {
    domain?: string;
    country?: string;
    merchantName?: string;
    dailyBudgetUsd?: number;
    maxCpcUsd?: number;
  };
  try {
    body = await req.json();
  } catch {
    return apiError("请求体不是合法 JSON");
  }

  const domain = String(body.domain || "").trim();
  const country = String(body.country || "US").trim().toUpperCase();
  const merchantName = String(body.merchantName || domain).trim();
  if (!domain) return apiError("domain 必填");

  // 预算/出价只影响 SemRush 侧的关键词挑选打分，Hermes 的 filter 模式不用它选词，
  // 给默认值即可（与 Hermes app_settings 的 default_budget_usd / default_cpc_usd 同量级）
  const dailyBudgetUsd = Number(body.dailyBudgetUsd) > 0 ? Number(body.dailyBudgetUsd) : 2.55;
  const maxCpcUsd = Number(body.maxCpcUsd) > 0 ? Number(body.maxCpcUsd) : 0.35;

  const r = await fetchSemrushKeywords({
    merchantUrl: domain.startsWith("http") ? domain : `https://${domain}`,
    country,
    merchantName,
    dailyBudgetUsd,
    maxCpcUsd,
    // 不传 userId：Hermes 是独立投放体，走全局账号池
  });

  const p = (r.payload || {}) as Record<string, unknown>;
  const num = (v: unknown) => (Number.isFinite(Number(v)) ? Number(v) : 0);

  // ok:false 也回 200 + ok:false——Hermes 要按 error_category 区分「这个商家没数据」
  // （跳过该候选）和「3UE 挂了/配额没了」（整轮别再打，等下一轮），HTTP 码区分不了这个。
  return apiSuccess({
    ok: r.ok,
    domain,
    country,
    deduped_titles: r.dedupedTitles || [],
    deduped_descriptions: r.dedupedDescriptions || [],
    keywords: r.keywords || [],
    raw_keyword_count: num(p.raw_keyword_count),
    paid_keyword_count: num(p.paid_keyword_count),
    total_copies: num(p.total_copies),
    creative_samples_count: num(p.creative_samples_count),
    from_cache: !!r.fromCache,
    cache_age_hours: r.cacheAgeHours ?? 0,
    error_category: r.errorCategory,
    error_message: r.errorMessage || "",
  });
}
