import { NextRequest } from "next/server";
import { getUserFromRequest, serializeData } from "@/lib/auth";
import { apiSuccess, apiError } from "@/lib/constants";
import { SemRushClient, parseDomainFromSemrushUrl } from "@/lib/semrush-client";
import { selectKeywordsWithAi } from "@/lib/keyword-selector";

/**
 * POST /api/user/ad-creation/semrush-url
 * 通过 3UE SemRush 页面链接获取关键词（手动兜底路径）
 * 关键词来源（D-047 / C-113）：SemRush「自然词池 + 付费词池」，由 AI 在真实池内「选词」（只选不造）。
 */

export async function POST(req: NextRequest) {
  try {
    const user = getUserFromRequest(req);
    if (!user) return apiError("未授权", 401);

    const body = await req.json();
    const url = String(body.url || "");
    const country = String(body.country || "US");
    const merchantName = String(body.merchant_name || "");
    const dailyBudgetUsd = Number(body.daily_budget) > 0 ? Number(body.daily_budget) : 2;
    const maxCpcUsd = Number(body.max_cpc) > 0 ? Number(body.max_cpc) : 0.3;
    if (!url) return apiError("请输入 3UE SemRush 链接");

    const domain = parseDomainFromSemrushUrl(url);
    if (!domain) {
      return apiError(
        "无法从链接中解析出域名，请确认链接格式正确（如 https://sem.3ue.co/analytics/overview/?q=...）",
      );
    }

    const client = await SemRushClient.fromUserConfig(user.userId, country);
    const result = await client.queryDomain(domain);

    // D-047: AI 从「自然词池(organic) + 付费词池(paid)」里选词（只选不造）
    const allKeywords = await selectKeywordsWithAi(result.keywords, result.paidKeywords, {
      merchantName,
      domain: result.domain,
      dailyBudgetUsd,
      maxCpcUsd,
    });

    return apiSuccess(
      serializeData({
        domain: result.domain,
        keywords: allKeywords,
        raw_keyword_count: result.keywords.length,
        paid_keyword_count: result.paidKeywords.length,
        deduped_titles: result.dedupedTitles,
        deduped_descriptions: result.dedupedDescriptions,
      }),
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn("[SemRush URL] 查询失败:", msg);
    return apiError(msg || "关键词获取失败，请稍后再试");
  }
}
