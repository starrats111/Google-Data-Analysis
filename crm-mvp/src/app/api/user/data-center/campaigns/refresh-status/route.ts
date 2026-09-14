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
    // D-330：CID 已撤销导致的回停单独报数——这批系列不在 Sheet 里，不计入 updated，
    // 若只报 updated 用户会看到「已同步 0 条」，与他眼前状态确实变了矛盾。
    const orphansPaused = results.reduce((sum, r) => sum + (r.orphans_paused ?? 0), 0);
    const msg = orphansPaused > 0
      ? `已同步 ${totalUpdated} 条状态；另有 ${orphansPaused} 个系列因所属 CID 已撤销/停用被回停`
      : `已同步 ${totalUpdated} 条状态`;
    return apiSuccess({ results, totalUpdated, orphansPaused }, msg);
  } catch (err) {
    return apiError(`同步失败: ${err instanceof Error ? err.message : String(err)}`);
  }
}
