import { NextRequest } from "next/server";
import { getUserFromRequest, serializeData } from "@/lib/auth";
import { apiError } from "@/lib/constants";
import { fetchSemrushKeywords } from "@/lib/semrush-keywords";

/**
 * POST /api/user/ad-creation/semrush
 * 关键词来源（D-047 / C-113）：SemRush「自然词池 + 付费词池」，由 AI 在真实池内「选词」
 * （只选不造，付费优先 + 自然补长尾，数量按预算 / CPC 自适应，match type 三因子）。
 *
 * D-091：核心流水线（含 I3 错误分类 / I6 24h 缓存兜底 / I7 路由层重试）已抽到
 * `@/lib/semrush-keywords`，与广告生成 core 任务共用同一实现。本路由仅做参数解析 + 响应组装。
 */
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

  const result = await fetchSemrushKeywords({ merchantUrl, country, merchantName, dailyBudgetUsd, maxCpcUsd });

  if (!result.ok) {
    return Response.json(
      { code: -1, message: result.errorMessage, data: { error_category: result.errorCategory } },
      { status: 400 },
    );
  }

  if (result.fromCache) {
    return Response.json({
      code: 0,
      message: "success_from_cache",
      data: serializeData({
        ...(result.payload ?? {}),
        from_cache: true,
        cache_age_hours: result.cacheAgeHours,
        error_category: "cache_fallback",
        error_message: result.errorMessage,
      }),
    });
  }

  return Response.json({
    code: 0,
    message: "success",
    data: serializeData({ ...(result.payload ?? {}), from_cache: false, error_category: null }),
  });
}
