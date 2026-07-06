import { NextRequest, NextResponse } from "next/server";
import { withUser } from "@/lib/api-handler";
import ExcelJS from "exceljs";
import { buildMemberMonthlyReport } from "@/lib/monthly-report";
import { buildFengduMonthSheet } from "@/lib/monthly-report-xlsx";

export const dynamic = "force-dynamic";

/**
 * GET /api/user/report/monthly/export?month=YYYY-MM
 * 组员导出自己的单月收支表 xlsx
 */
export const GET = withUser(async (req: NextRequest, { user }) => {
  const month = new URL(req.url).searchParams.get("month") || "";
  if (!/^\d{4}-\d{2}$/.test(month)) {
    return NextResponse.json({ code: -1, message: "month 格式必须为 YYYY-MM", data: null }, { status: 400 });
  }

  const report = await buildMemberMonthlyReport(BigInt(user.userId), month);

  const wb = new ExcelJS.Workbook();
  wb.creator = "CRM System";
  wb.created = new Date();
  // R-06：与「丰度收支统计表」月份 sheet 完全同版式（单人 = 只有自己一个成员块）
  buildFengduMonthSheet(wb, [report], `${parseInt(month.slice(5), 10)}月份`);

  const buffer = await wb.xlsx.writeBuffer();
  const filename = encodeURIComponent(`${report.username}${month}收支统计.xlsx`);
  return new NextResponse(new Uint8Array(buffer as ArrayBuffer), {
    status: 200,
    headers: {
      "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      "Content-Disposition": `attachment; filename*=UTF-8''${filename}`,
      "Cache-Control": "no-store",
    },
  });
});
