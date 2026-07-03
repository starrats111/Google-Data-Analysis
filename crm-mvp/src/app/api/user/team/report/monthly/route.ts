import { NextRequest } from "next/server";
import { apiSuccess, apiError } from "@/lib/constants";
import { withLeader } from "@/lib/api-handler";
import prisma from "@/lib/prisma";
import { buildMemberMonthlyReport } from "@/lib/monthly-report";

export const dynamic = "force-dynamic";

/**
 * GET /api/user/team/report/monthly?month=YYYY-MM&userId=xxx
 * 组长查看本组任一组员的单月收支表
 */
export const GET = withLeader(async (req: NextRequest, { user }) => {
  const { searchParams } = new URL(req.url);
  const month = searchParams.get("month") || "";
  const userId = searchParams.get("userId") || "";
  if (!/^\d{4}-\d{2}$/.test(month)) return apiError("month 格式必须为 YYYY-MM");
  if (!/^\d+$/.test(userId)) return apiError("userId 无效");
  if (!user.teamId) return apiError("未关联小组");

  const member = await prisma.users.findFirst({
    where: { id: BigInt(userId), team_id: BigInt(user.teamId), is_deleted: 0 },
    select: { id: true },
  });
  if (!member) return apiError("该成员不属于本组");

  const report = await buildMemberMonthlyReport(member.id, month);
  return apiSuccess(report);
});
