import { NextRequest, NextResponse } from "next/server";
import { withUser } from "@/lib/api-handler";
import ExcelJS from "exceljs";
import { buildMemberAnnualReport } from "@/lib/monthly-report";
import { buildMemberAnnualSheet } from "@/lib/monthly-report-xlsx";

export const dynamic = "force-dynamic";

/**
 * GET /api/user/report/annual/export?year=YYYY
 * 组员导出自己的个人年度收支表 xlsx
 */
export const GET = withUser(async (req: NextRequest, { user }) => {
  const yearStr = new URL(req.url).searchParams.get("year") || "";
  const year = parseInt(yearStr, 10);
  if (!/^\d{4}$/.test(yearStr) || year < 2020 || year > 2100) {
    return NextResponse.json({ code: -1, message: "year 格式必须为 YYYY", data: null }, { status: 400 });
  }

  const report = await buildMemberAnnualReport(BigInt(user.userId), year);

  const wb = new ExcelJS.Workbook();
  wb.creator = "CRM System";
  wb.created = new Date();
  buildMemberAnnualSheet(wb, report);

  const buffer = await wb.xlsx.writeBuffer();
  const filename = encodeURIComponent(`${report.username}${year}年度收支统计.xlsx`);
  return new NextResponse(new Uint8Array(buffer as ArrayBuffer), {
    status: 200,
    headers: {
      "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      "Content-Disposition": `attachment; filename*=UTF-8''${filename}`,
      "Cache-Control": "no-store",
    },
  });
});
