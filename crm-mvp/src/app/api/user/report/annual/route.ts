import { NextRequest } from "next/server";
import { apiSuccess, apiError } from "@/lib/constants";
import { withUser } from "@/lib/api-handler";
import { buildMemberAnnualReport } from "@/lib/monthly-report";

export const dynamic = "force-dynamic";

/**
 * GET /api/user/report/annual?year=YYYY
 * 组员自己的个人年度收支报表（逐月合计，不分上下半月）
 */
export const GET = withUser(async (req: NextRequest, { user }) => {
  const yearStr = new URL(req.url).searchParams.get("year") || "";
  const year = parseInt(yearStr, 10);
  if (!/^\d{4}$/.test(yearStr) || year < 2020 || year > 2100) {
    return apiError("year 格式必须为 YYYY");
  }

  const report = await buildMemberAnnualReport(BigInt(user.userId), year);
  return apiSuccess(report);
});
