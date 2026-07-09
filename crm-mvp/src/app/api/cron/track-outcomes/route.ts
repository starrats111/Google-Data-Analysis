/**
 * GET /api/cron/track-outcomes - 决策结果回验（批次6）
 *
 * 扫 ad_decision_journal 中建议已满 3/7 天但未回填结果的记录，
 * 取「建议次日起 N 天」的实际花费/佣金/订单，写入 outcome_3d / outcome_7d，
 * 7 天结果同时评判 verdict（correct / partial / wrong / no_data），
 * 形成「建议 → 结果 → 准确率」闭环。
 *
 * crontab 示例（服务器，每天 08:00）：
 *   0 8 * * * curl -s -H 'Authorization: Bearer ${CRON_SECRET}' 'http://localhost:20050/api/cron/track-outcomes' >> /var/log/crm-cron/track-outcomes.log 2>&1
 *
 * 鉴权：CRON_SECRET（Authorization: Bearer ...）
 */

import { NextRequest, NextResponse } from "next/server";
import prisma from "@/lib/prisma";
import { buildOutcome, judgeDecision, type DecisionActionType, type CampaignSnapshot } from "@/lib/decision-engine";
import { getCommissionFromTxn } from "@/lib/ai-insight";
import { dateColumnStart, dateColumnEndExclusive } from "@/lib/date-utils";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

let isRunning = false;

function verifyCron(req: NextRequest): boolean {
  const secret = process.env.CRON_SECRET;
  if (!secret) return false;
  return req.headers.get("authorization") === `Bearer ${secret}`;
}

/** 建议次日起 N 天的 CST 日期窗口（建议当天数据已计入快照，不重复计） */
function outcomeWindow(createdAt: Date, days: number): { from: string; to: string } {
  const base = new Date(createdAt.getTime() + 8 * 3600_000);
  const start = new Date(base.getTime() + 86_400_000);
  const end = new Date(base.getTime() + days * 86_400_000);
  return { from: start.toISOString().slice(0, 10), to: end.toISOString().slice(0, 10) };
}

async function computeOutcome(row: {
  user_id: bigint;
  campaign_id: bigint;
  created_at: Date;
}, days: number) {
  const { from, to } = outcomeWindow(row.created_at, days);

  const stat = await prisma.ads_daily_stats.aggregate({
    where: {
      campaign_id: row.campaign_id,
      date: { gte: dateColumnStart(from), lt: dateColumnEndExclusive(to) },
      is_deleted: 0,
    },
    _sum: { cost: true, orders: true },
  });

  // 佣金按该系列所属商家（与 analyze-campaigns 快照口径一致）
  const campaign = await prisma.campaigns.findUnique({
    where: { id: row.campaign_id },
    select: { user_merchant_id: true },
  });
  let commission = 0;
  if (campaign?.user_merchant_id) {
    const comm = await getCommissionFromTxn(row.user_id, from, to);
    const m = comm.byMerchant.get(campaign.user_merchant_id.toString());
    if (m) commission = m.total - m.rejected;
  }

  return buildOutcome({
    spend: Number(stat._sum.cost ?? 0),
    commission,
    orders: Number(stat._sum.orders ?? 0),
  });
}

export async function GET(req: NextRequest) {
  if (!verifyCron(req)) {
    return NextResponse.json({ code: -1, message: "未授权" }, { status: 401 });
  }
  if (isRunning) {
    return NextResponse.json({ code: 0, message: "上一轮回验仍在进行，跳过", data: null });
  }
  isRunning = true;
  const startedAt = Date.now();

  try {
    const now = Date.now();
    const dayMs = 86_400_000;
    let filled3d = 0, filled7d = 0, failed = 0;
    const verdictCounts: Record<string, number> = {};

    // 满 3 天未回填 3d 结果的（单轮上限 200，低配机防过载；漏掉的下轮补）
    const due3d = await prisma.ad_decision_journal.findMany({
      where: { outcome_3d: { equals: null as never }, is_deleted: 0, created_at: { lte: new Date(now - 3 * dayMs) } },
      select: { id: true, user_id: true, campaign_id: true, created_at: true },
      orderBy: { created_at: "asc" },
      take: 200,
    });
    for (const row of due3d) {
      try {
        const outcome = await computeOutcome(row, 3);
        await prisma.ad_decision_journal.update({
          where: { id: row.id },
          data: { outcome_3d: outcome as unknown as object },
        });
        filled3d++;
      } catch (e) {
        failed++;
        console.error(`[CRON track-outcomes] journal=${row.id} 3d 回填失败:`, e instanceof Error ? e.message : e);
      }
    }

    // 满 7 天未回填 7d 结果的 → 回填 + 评判
    const due7d = await prisma.ad_decision_journal.findMany({
      where: { outcome_7d: { equals: null as never }, is_deleted: 0, created_at: { lte: new Date(now - 7 * dayMs) } },
      select: { id: true, user_id: true, campaign_id: true, created_at: true, action_type: true, snapshot_json: true },
      orderBy: { created_at: "asc" },
      take: 200,
    });
    for (const row of due7d) {
      try {
        const outcome = await computeOutcome(row, 7);
        const snapshot = row.snapshot_json as unknown as CampaignSnapshot;
        const verdict = judgeDecision(row.action_type as DecisionActionType, Number(snapshot?.roi ?? 0), outcome);
        await prisma.ad_decision_journal.update({
          where: { id: row.id },
          data: { outcome_7d: outcome as unknown as object, verdict },
        });
        filled7d++;
        verdictCounts[verdict] = (verdictCounts[verdict] ?? 0) + 1;
      } catch (e) {
        failed++;
        console.error(`[CRON track-outcomes] journal=${row.id} 7d 回填失败:`, e instanceof Error ? e.message : e);
      }
    }

    const summary = { filled3d, filled7d, failed, verdicts: verdictCounts, elapsed_ms: Date.now() - startedAt };
    console.log(`[CRON track-outcomes] ${JSON.stringify(summary)}`);
    return NextResponse.json({ code: 0, message: "ok", data: summary });
  } catch (e) {
    console.error("[CRON track-outcomes] 执行异常:", e instanceof Error ? e.message : e);
    return NextResponse.json(
      { code: -1, message: e instanceof Error ? e.message : "回验失败" },
      { status: 500 },
    );
  } finally {
    isRunning = false;
  }
}
