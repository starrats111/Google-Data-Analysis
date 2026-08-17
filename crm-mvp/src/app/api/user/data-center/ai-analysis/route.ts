import { NextRequest } from "next/server";
import { getUserFromRequest } from "@/lib/auth";
import { apiSuccess, apiError } from "@/lib/constants";
import prisma from "@/lib/prisma";
import {
  analyzeCampaigns,
  getCachedRecommendations,
  isValidAnalysisStrategy,
  type AnalysisStrategy,
} from "@/lib/campaign-analysis";
import { resolveCampaignReadScopes } from "@/lib/campaign-read-access";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

/**
 * D-238 数据中心广告 AI 分析
 *
 * GET  ?ids=1,2,3&strategy=balanced  只读缓存（页面加载展示操作建议列，不触发 AI）
 *      D-241：组长可读本组组员系列的缓存建议（按归属人查询）；POST 仍仅限本人
 * POST { campaignIds, strategy?, forceRefresh?, detailed? }
 *   - 一键分析：campaignIds 多个 + detailed=false（快速批量，命中缓存不重跑）
 *   - 重新分析：campaignIds 单个 + detailed=true + forceRefresh=true（双层详细分析）
 */

function parseIds(raw: unknown): bigint[] {
  if (!Array.isArray(raw)) return [];
  const out: bigint[] = [];
  for (const v of raw) {
    try {
      const id = BigInt(String(v));
      if (id > BigInt(0)) out.push(id);
    } catch { /* 非法 id 忽略 */ }
  }
  return out;
}

async function assertOwnership(userId: bigint, ids: bigint[]): Promise<string | null> {
  const owned = await prisma.campaigns.findMany({
    where: { id: { in: ids }, user_id: userId, is_deleted: 0 },
    select: { id: true },
  });
  const ownedSet = new Set(owned.map((c) => String(c.id)));
  const bad = ids.filter((id) => !ownedSet.has(String(id)));
  return bad.length > 0 ? `无权分析以下广告系列: ${bad.join(", ")}` : null;
}

export async function GET(req: NextRequest) {
  const user = getUserFromRequest(req);
  if (!user) return apiError("未授权", 401);

  const idsParam = req.nextUrl.searchParams.get("ids") || "";
  const ids = parseIds(idsParam.split(",").filter(Boolean));
  if (ids.length === 0) return apiSuccess({ items: [] });

  const strategyParam = req.nextUrl.searchParams.get("strategy");
  const strategy: AnalysisStrategy = isValidAnalysisStrategy(strategyParam) ? strategyParam : "balanced";

  // D-241：按归属人分组查缓存——本人直接放行，组长可只读本组组员，越域整体 403
  const scopes = await resolveCampaignReadScopes(user, ids);
  if (!scopes) return apiError("无权查看该广告系列的分析建议", 403);

  const items = [];
  for (const [ownerId, ownerIds] of scopes) {
    items.push(...await getCachedRecommendations(BigInt(ownerId), ownerIds, strategy));
  }
  return apiSuccess({ items });
}

export async function POST(req: NextRequest) {
  const user = getUserFromRequest(req);
  if (!user) return apiError("未授权", 401);

  const body = await req.json();
  const ids = parseIds(body.campaignIds);
  if (ids.length === 0) return apiError("请提供至少一个广告系列 ID", 400);
  if (ids.length > 200) return apiError("单次最多分析 200 个广告系列", 400);

  const strategy: AnalysisStrategy = isValidAnalysisStrategy(body.strategy) ? body.strategy : "balanced";
  const detailed = Boolean(body.detailed);
  if (detailed && ids.length > 1) return apiError("详细分析一次只支持单个广告系列", 400);

  const userId = BigInt(user.userId);
  const ownershipError = await assertOwnership(userId, ids);
  if (ownershipError) return apiError(ownershipError, 403);

  try {
    const result = await analyzeCampaigns({
      userId,
      campaignIds: ids,
      strategy,
      forceRefresh: Boolean(body.forceRefresh),
      detailed,
    });
    if (!result.configured) {
      return apiError("广告分析未配置：请联系管理员在系统配置中导入分析提示词", 503);
    }
    return apiSuccess({ items: result.items });
  } catch (err) {
    return apiError(`AI 分析失败: ${err instanceof Error ? err.message : String(err)}`, 500);
  }
}
