import { NextRequest } from "next/server";
import { serializeData } from "@/lib/auth";
import { apiSuccess } from "@/lib/constants";
import { withUser } from "@/lib/api-handler";
import prisma from "@/lib/prisma";

/**
 * GET /api/user/decision-journal - AI 决策建议列表（批次6）
 *
 * 查询参数：
 *   page / pageSize
 *   action_type：pause / decrease_budget / increase_budget / keep / observe
 *   verdict：correct / partial / wrong / no_data
 *
 * 附带 summary：已评判建议的准确率统计（correct/partial/wrong 计数）。
 */
export const GET = withUser(async (req: NextRequest, { user }) => {
  const { searchParams } = new URL(req.url);
  const page = Math.max(parseInt(searchParams.get("page") || "1"), 1);
  const pageSize = Math.min(parseInt(searchParams.get("pageSize") || "20"), 100);
  const actionType = searchParams.get("action_type") || undefined;
  const verdict = searchParams.get("verdict") || undefined;

  const where = {
    user_id: BigInt(user.userId),
    is_deleted: 0,
    ...(actionType ? { action_type: actionType } : {}),
    ...(verdict ? { verdict } : {}),
  };

  const [total, rows, verdictGroups] = await Promise.all([
    prisma.ad_decision_journal.count({ where }),
    prisma.ad_decision_journal.findMany({
      where,
      orderBy: { created_at: "desc" },
      skip: (page - 1) * pageSize,
      take: pageSize,
    }),
    prisma.ad_decision_journal.groupBy({
      by: ["verdict"],
      where: { user_id: BigInt(user.userId), is_deleted: 0, verdict: { not: null } },
      _count: { _all: true },
    }),
  ]);

  const summary: Record<string, number> = {};
  let judged = 0;
  for (const g of verdictGroups) {
    if (!g.verdict) continue;
    summary[g.verdict] = g._count._all;
    if (g.verdict !== "no_data") judged += g._count._all;
  }
  const correct = summary["correct"] ?? 0;
  const partial = summary["partial"] ?? 0;
  const accuracy = judged > 0 ? Math.round(((correct + partial * 0.5) / judged) * 100) : null;

  return apiSuccess(serializeData({
    list: rows,
    total,
    page,
    pageSize,
    summary: { ...summary, judged, accuracy },
  }));
});
