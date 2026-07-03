import { NextRequest } from "next/server";
import { apiSuccess, apiError } from "@/lib/constants";
import { withLeader } from "@/lib/api-handler";
import { buildTeamMonthlySummary } from "@/lib/monthly-report";

export const dynamic = "force-dynamic";

/**
 * GET /api/user/team/report/monthly-summary?month=YYYY-MM
 * 组长总计表：全员单表累计 + 平台聚合 + 实收 3 列（USD 累计 / 预估 CNY / 实际 CNY 手填）
 */
export const GET = withLeader(async (req: NextRequest, { user }) => {
  const month = new URL(req.url).searchParams.get("month") || "";
  if (!/^\d{4}-\d{2}$/.test(month)) return apiError("month 格式必须为 YYYY-MM");
  if (!user.teamId) return apiError("未关联小组");

  const summary = await buildTeamMonthlySummary(BigInt(user.teamId), BigInt(user.userId), month);
  return apiSuccess(summary);
});
