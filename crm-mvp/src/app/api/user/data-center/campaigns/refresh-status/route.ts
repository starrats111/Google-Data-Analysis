import { NextRequest } from "next/server";
import { getUserFromRequest } from "@/lib/auth";
import { apiSuccess, apiError } from "@/lib/constants";
import { syncUserCampaignStatusesFromSheet } from "@/lib/sheet-status-sync";

/**
 * POST /api/user/data-center/campaigns/refresh-status
 * 从各 MCC 的 Google Sheet（CampaignInfo Tab）拉取当前用户所有广告系列的最新状态，
 * 更新到数据库。零 Google Ads API 调用——旧版走 API 全量扫描把共享 Developer Token
 * 配额打爆（页面一开 = 上百次 GAQL），已整体切换到 Sheet 数据源。
 */
export async function POST(req: NextRequest) {
  const user = getUserFromRequest(req);
  if (!user) return apiError("未授权", 401);

  try {
    const results = await syncUserCampaignStatusesFromSheet(BigInt(user.userId));
    const totalUpdated = results.reduce((sum, r) => sum + r.updated, 0);
    return apiSuccess({ results, totalUpdated }, `已同步 ${totalUpdated} 条状态`);
  } catch (err) {
    return apiError(`同步失败: ${err instanceof Error ? err.message : String(err)}`);
  }
}
