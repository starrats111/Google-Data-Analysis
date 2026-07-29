import { NextRequest } from "next/server";
import { serializeData } from "@/lib/auth";
import { apiSuccess, apiError } from "@/lib/constants";
import { withLeader } from "@/lib/api-handler";
import prisma from "@/lib/prisma";
import { queryCampaignBoard, CampaignBoardError } from "@/lib/campaign-board-query";

/**
 * GET /api/user/team/member-data
 * 组长查看组员的广告系列看板。
 *
 * D-194：改为复用 `@/lib/campaign-board-query`，与组员自己看到的
 * `/api/user/data-center/campaigns` 完全同源——行集合、状态自愈、MCC 过滤、
 * REMOVED 隐藏规则、D-168 归集与 D-176 单 MCC 佣金口径全部一致。
 * 响应结构也与数据中心对齐（rows / summary / costByMcc / rowMeta），
 * 额外返回 mccAccounts 供弹窗切到与组员相同的 MCC 视图。
 */
export const GET = withLeader(async (req: NextRequest, { user }) => {
  const { searchParams } = new URL(req.url);
  const targetUserId = searchParams.get("userId");

  if (!targetUserId) return apiError("缺少 userId 参数");
  if (!user.teamId) return apiError("未关联小组");

  let targetIdBig: bigint;
  try {
    targetIdBig = BigInt(targetUserId);
  } catch {
    return apiError("userId 格式无效");
  }

  const targetUser = await prisma.users.findFirst({
    where: { id: targetIdBig, team_id: BigInt(user.teamId), is_deleted: 0 },
    select: { id: true, username: true, display_name: true },
  });

  if (!targetUser) return apiError("该用户不属于您的小组", 403);

  // 兼容组长弹窗历史参数名 start_date/end_date，同时接受数据中心的 date_start/date_end
  const dateStart = searchParams.get("date_start") ?? searchParams.get("start_date");
  const dateEnd = searchParams.get("date_end") ?? searchParams.get("end_date");

  try {
    const board = await queryCampaignBoard(targetUser.id, {
      mccAccountId: searchParams.get("mcc_account_id"),
      dateStart,
      dateEnd,
      status: searchParams.get("status"),
      platform: searchParams.get("platform"),
      mid: searchParams.get("mid"),
      search: searchParams.get("search"),
    });

    return apiSuccess(serializeData({
      user: {
        id: targetUser.id.toString(),
        username: targetUser.username,
        display_name: targetUser.display_name,
      },
      rows: board.rows,
      summary: board.summary,
      costByMcc: board.costByMcc,
      rowMeta: board.rowMeta,
      mccAccounts: board.mccAccounts,
    }));
  } catch (e) {
    if (e instanceof CampaignBoardError) return apiError(e.message, e.status);
    throw e;
  }
});
