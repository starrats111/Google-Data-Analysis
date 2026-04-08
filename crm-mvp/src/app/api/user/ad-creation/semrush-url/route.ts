import { NextRequest } from "next/server";
import { getUserFromRequest, serializeData } from "@/lib/auth";
import { apiSuccess, apiError } from "@/lib/constants";
import prisma from "@/lib/prisma";
import { SemRushClient, parseDomainFromSemrushUrl } from "@/lib/semrush-client";
import { selectOptimizedKeywords } from "@/lib/ad-keyword-pipeline";

/**
 * POST /api/user/ad-creation/semrush-url
 * 通过 3UE SemRush 页面链接获取关键词（自动获取失败时的备选方案）
 */
export async function POST(req: NextRequest) {
  const user = getUserFromRequest(req);
  if (!user) return apiError("未授权", 401);

  const { url, country = "US", merchant_name = "", daily_budget, max_cpc, bidding_strategy } = await req.json();
  if (!url) return apiError("请输入 3UE SemRush 链接");

  const settings = await prisma.ad_default_settings.findFirst({
    where: { user_id: BigInt(user.userId), is_deleted: 0 },
    select: { ai_rule_profile: true },
  });

  const domain = parseDomainFromSemrushUrl(url);
  if (!domain) {
    return apiError("无法从链接中解析出域名，请确认链接格式正确（如 https://sem.3ue.co/analytics/overview/?q=...）");
  }

  // 方式一：标准 RPC 查询
  try {
    const client = await SemRushClient.fromConfig(country);
    const result = await client.queryDomain(domain);
    const optimizedKeywords = selectOptimizedKeywords(result.keywords, {
      merchantName: merchant_name,
      dailyBudget: Number(daily_budget || 0),
      maxCpc: Number(max_cpc || 0),
      biddingStrategy: bidding_strategy,
      aiRuleProfile: settings?.ai_rule_profile,
      limit: 8,
    });
    return apiSuccess(serializeData({
      domain: result.domain,
      keywords: optimizedKeywords,
      raw_keywords: result.keywords,
      raw_keyword_count: result.keywords.length,
      deduped_titles: result.dedupedTitles,
      deduped_descriptions: result.dedupedDescriptions,
    }));
  } catch (rpcErr) {
    console.warn("[SemRush URL] RPC 查询失败:", rpcErr instanceof Error ? rpcErr.message : rpcErr);
  }

  // 方式二：尝试从页面 URL 抓取嵌入数据
  try {
    const client = await SemRushClient.fromConfig(country);
    const keywords = await client.fetchFromPageUrl(url);
    if (keywords.length > 0) {
      const optimizedKeywords = selectOptimizedKeywords(keywords, {
        merchantName: merchant_name,
        dailyBudget: Number(daily_budget || 0),
        maxCpc: Number(max_cpc || 0),
        biddingStrategy: bidding_strategy,
        aiRuleProfile: settings?.ai_rule_profile,
        limit: 8,
      });
      return apiSuccess(serializeData({ domain, keywords: optimizedKeywords, raw_keywords: keywords }));
    }
  } catch (pageErr) {
    console.warn("[SemRush URL] 页面抓取失败:", pageErr instanceof Error ? pageErr.message : pageErr);
  }

  return apiError(
    `无法获取 ${domain} 的关键词数据，3UE 账户可能已过期。请联系管理员检查 SemRush 配置，或在下方手动输入关键词`,
  );
}
