import { NextRequest } from "next/server";
import { getUserFromRequest } from "@/lib/auth";
import { apiSuccess, apiError } from "@/lib/constants";
import { padHeadlines, padDescriptions } from "@/lib/ai-service";

/**
 * POST /api/user/ad-creation/generate-more
 * AI 生成更多标题或描述（基于已有内容补充）
 */
export async function POST(req: NextRequest) {
  const user = getUserFromRequest(req);
  if (!user) return apiError("未授权", 401);

  const { type, existing, merchant_name, country, count } = await req.json();

  if (!type || !["headlines", "descriptions"].includes(type)) {
    return apiError("type 必须为 headlines 或 descriptions");
  }

  const existingItems = Array.isArray(existing) ? existing.filter((s: string) => s?.trim()) : [];
  const targetCount = Math.min(count || (type === "headlines" ? 15 : 4), type === "headlines" ? 15 : 4);

  try {
    if (type === "headlines") {
      const result = await padHeadlines(existingItems, merchant_name || "", country || "US", targetCount);
      const newItems = result.filter((h) => !existingItems.includes(h));
      return apiSuccess({ items: newItems });
    } else {
      const result = await padDescriptions(existingItems, merchant_name || "", country || "US", targetCount);
      const newItems = result.filter((d) => !existingItems.includes(d));
      return apiSuccess({ items: newItems });
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("[GenerateMore]", msg);
    return apiError(`AI 生成失败: ${msg.slice(0, 200)}`);
  }
}
