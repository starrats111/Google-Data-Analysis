import { NextRequest } from "next/server";
import { apiSuccess, apiError } from "@/lib/constants";
import { withLeader } from "@/lib/api-handler";
import { buildTeamAnnualReport } from "@/lib/monthly-report";

export const dynamic = "force-dynamic";

/**
 * GET /api/user/team/report/annual-v2?year=2026
 * R-04.2 年度收支报表（新口径）：整年 12 个月 × 新样式指标
 * （账面/失效/应收/实收/广告费$¥/核算广告费¥/实际佣金¥/可分配利润¥）
 */
export const GET = withLeader(async (req: NextRequest, { user }) => {
  const { searchParams } = new URL(req.url);
  const year = parseInt(searchParams.get("year") || String(new Date().getFullYear()), 10);
  if (isNaN(year) || year < 2020 || year > 2100) return apiError("无效年份");
  if (!user.teamId) return apiError("未关联小组");

  const report = await buildTeamAnnualReport(BigInt(user.teamId), BigInt(user.userId), year);
  return apiSuccess(report);
});
