import { NextRequest, NextResponse } from "next/server";
import { withLeader } from "@/lib/api-handler";
import ExcelJS from "exceljs";
import { buildTeamAnnualReport } from "@/lib/monthly-report";
import { buildAnnualSheet } from "@/lib/monthly-report-xlsx";

export const dynamic = "force-dynamic";

/**
 * GET /api/user/team/report/annual-v2/export?year=2026
 * R-04.2 年度收支报表（新口径）xlsx 导出
 */
export const GET = withLeader(async (req: NextRequest, { user }) => {
  const year = parseInt(new URL(req.url).searchParams.get("year") || String(new Date().getFullYear()), 10);
  if (isNaN(year) || year < 2020 || year > 2100) {
    return NextResponse.json({ code: -1, message: "无效年份", data: null }, { status: 400 });
  }
  if (!user.teamId) {
    return NextResponse.json({ code: -1, message: "未关联小组", data: null }, { status: 400 });
  }

  const report = await buildTeamAnnualReport(BigInt(user.teamId), BigInt(user.userId), year);

  const wb = new ExcelJS.Workbook();
  wb.creator = "CRM System";
  wb.created = new Date();
  buildAnnualSheet(wb, report);

  const buffer = await wb.xlsx.writeBuffer();
  const filename = encodeURIComponent(`${year}年度收支报表.xlsx`);
  return new NextResponse(new Uint8Array(buffer as ArrayBuffer), {
    status: 200,
    headers: {
      "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      "Content-Disposition": `attachment; filename*=UTF-8''${filename}`,
      "Cache-Control": "no-store",
    },
  });
});
