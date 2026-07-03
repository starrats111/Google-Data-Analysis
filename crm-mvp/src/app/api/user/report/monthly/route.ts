import { NextRequest } from "next/server";
import { apiSuccess, apiError } from "@/lib/constants";
import { withUser } from "@/lib/api-handler";
import { buildMemberMonthlyReport } from "@/lib/monthly-report";

export const dynamic = "force-dynamic";

/**
 * GET /api/user/report/monthly?month=YYYY-MM
 * 组员自己的单月收支报表（视图模型）
 */
export const GET = withUser(async (req: NextRequest, { user }) => {
  const month = new URL(req.url).searchParams.get("month") || "";
  if (!/^\d{4}-\d{2}$/.test(month)) return apiError("month 格式必须为 YYYY-MM");

  const report = await buildMemberMonthlyReport(BigInt(user.userId), month);
  return apiSuccess(report);
});
