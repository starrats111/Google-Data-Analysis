import { NextRequest } from "next/server";
import { getUserFromRequest, serializeData } from "@/lib/auth";
import { apiSuccess, apiError } from "@/lib/constants";
import { SemRushClient } from "@/lib/semrush-client";

/**
 * POST /api/user/ad-creation/semrush
 * 获取 SemRush 竞品数据（标题/描述/关键词）
 */
export async function POST(req: NextRequest) {
  const user = getUserFromRequest(req);
  if (!user) return apiError("未授权", 401);

  const { merchant_url, country = "US" } = await req.json();
  if (!merchant_url) return apiError("缺少商家 URL");

  try {
    const client = await SemRushClient.fromConfig(country);
    const result = await client.queryDomain(merchant_url);

    return apiSuccess(serializeData({
      domain: result.domain,
      deduped_titles: result.dedupedTitles,
      deduped_descriptions: result.dedupedDescriptions,
      keywords: result.keywords,
      total_copies: result.copies.total,
      creative_samples_count: result.creativeSamples.length,
    }));
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("[SemRush API]", msg);
    return apiError(`SemRush 查询失败: ${msg.slice(0, 200)}`);
  }
}
