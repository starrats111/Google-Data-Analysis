import { NextRequest } from "next/server";
import { getUserFromRequest, serializeData } from "@/lib/auth";
import { apiSuccess, apiError } from "@/lib/constants";
import { queryCampaignBoard, CampaignBoardError } from "@/lib/campaign-board-query";

/**
 * GET /api/user/data-center/campaigns
 * 广告系列列表查询（数据中心主表格数据）
 *
 * D-194：查询逻辑已抽到 `@/lib/campaign-board-query`，与组长侧
 * `/api/user/team/member-data` 共用同一实现，两个视角的行集合与口径从结构上保证一致。
 *
 * 筛选参数：
 * - mcc_account_id: MCC 账户 ID（可选，不传则查所有 MCC）
 * - date_start / date_end: 日期范围
 * - status: 广告状态 ENABLED / PAUSED / REMOVED
 * - platform: 平台代码
 * - mid: 商家 MID
 * - search: 搜索广告系列名
 */
export async function GET(req: NextRequest) {
  const user = getUserFromRequest(req);
  if (!user) return apiError("未授权", 401);

  const { searchParams } = new URL(req.url);

  try {
    const board = await queryCampaignBoard(BigInt(user.userId), {
      mccAccountId: searchParams.get("mcc_account_id"),
      dateStart: searchParams.get("date_start"),
      dateEnd: searchParams.get("date_end"),
      status: searchParams.get("status"),
      platform: searchParams.get("platform"),
      mid: searchParams.get("mid"),
      search: searchParams.get("search"),
    });

    return apiSuccess(serializeData({
      rows: board.rows,
      summary: board.summary,
      costByMcc: board.costByMcc,
      rowMeta: board.rowMeta,
    }));
  } catch (e) {
    if (e instanceof CampaignBoardError) return apiError(e.message, e.status);
    throw e;
  }
}
