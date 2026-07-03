import { NextRequest, NextResponse } from "next/server";
import { withLeader } from "@/lib/api-handler";
import ExcelJS from "exceljs";
import { buildTeamMonthlySummary } from "@/lib/monthly-report";
import { buildMemberSheet, buildSummarySheet } from "@/lib/monthly-report-xlsx";

export const dynamic = "force-dynamic";

/**
 * GET /api/user/team/report/monthly-summary/export?month=YYYY-MM
 * 组长导出：总计表 sheet + 每个组员一个单表 sheet
 */
export const GET = withLeader(async (req: NextRequest, { user }) => {
  const month = new URL(req.url).searchParams.get("month") || "";
  if (!/^\d{4}-\d{2}$/.test(month)) {
    return NextResponse.json({ code: -1, message: "month 格式必须为 YYYY-MM", data: null }, { status: 400 });
  }
  if (!user.teamId) {
    return NextResponse.json({ code: -1, message: "未关联小组", data: null }, { status: 400 });
  }

  const summary = await buildTeamMonthlySummary(BigInt(user.teamId), BigInt(user.userId), month);

  const wb = new ExcelJS.Workbook();
  wb.creator = "CRM System";
  wb.created = new Date();
  buildSummarySheet(wb, summary);
  // sheet 名去重（display_name 可能重复）
  const usedNames = new Set<string>(["总计表"]);
  for (const rep of summary.memberReports) {
    let name = rep.displayName.slice(0, 25);
    let i = 2;
    while (usedNames.has(name)) name = `${rep.displayName.slice(0, 22)}(${i++})`;
    usedNames.add(name);
    buildMemberSheet(wb, rep, name);
  }

  const buffer = await wb.xlsx.writeBuffer();
  const filename = encodeURIComponent(`团队收支月报-${month}.xlsx`);
  return new NextResponse(new Uint8Array(buffer as ArrayBuffer), {
    status: 200,
    headers: {
      "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      "Content-Disposition": `attachment; filename*=UTF-8''${filename}`,
      "Cache-Control": "no-store",
    },
  });
});
