import { NextRequest } from "next/server";
import { getUserFromRequest } from "@/lib/auth";
import { apiSuccess, apiError } from "@/lib/constants";
import { syncUserCampaignStatuses } from "@/lib/google-ads/status-sync";

/**
 * POST /api/user/data-center/campaigns/refresh-status
 * 从 Google Ads 拉取当前用户所有广告系列的最新状态，更新到数据库
 */
export async function POST(req: NextRequest) {
  const user = getUserFromRequest(req);
  if (!user) return apiError("未授权", 401);

  try {
    const results = await syncUserCampaignStatuses(BigInt(user.userId));
    const totalUpdated = results.reduce((sum, r) => sum + r.updated, 0);
    return apiSuccess({ results, totalUpdated }, `已同步 ${totalUpdated} 条状态`);
  } catch (err) {
    return apiError(`同步失败: ${err instanceof Error ? err.message : String(err)}`);
  }
}
