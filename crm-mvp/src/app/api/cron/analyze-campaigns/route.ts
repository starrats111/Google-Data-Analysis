/**
 * GET /api/cron/analyze-campaigns - 每日广告系列决策建议（批次6）
 *
 * 对每个在投（google_status=ENABLED）系列，取近 7 天表现快照，跑规则决策引擎
 * （src/lib/decision-engine.ts），把建议写入 ad_decision_journal。
 * 同一系列同一天 decision_id 唯一，cron 重跑幂等。
 * 建议不自动执行；3/7 天后由 track-outcomes cron 回填实际走势评判建议对错。
 *
 * crontab 示例（服务器，每天 07:30，在 daily-sync 06:00 数据落库之后）：
 *   30 7 * * * curl -s -H 'Authorization: Bearer ${CRON_SECRET}' 'http://localhost:20050/api/cron/analyze-campaigns' >> /var/log/crm-cron/analyze-campaigns.log 2>&1
 *
 * 鉴权：CRON_SECRET（Authorization: Bearer ...）
 */

import { NextRequest, NextResponse } from "next/server";
import prisma from "@/lib/prisma";
import { buildSnapshot, decide, buildDecisionId } from "@/lib/decision-engine";
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

function cstDateStr(offsetDays = 0): string {
  return new Date(Date.now() + 8 * 3600_000 + offsetDays * 86_400_000).toISOString().slice(0, 10);
}

export async function GET(req: NextRequest) {
  if (!verifyCron(req)) {
    return NextResponse.json({ code: -1, message: "未授权" }, { status: 401 });
  }
  if (isRunning) {
    return NextResponse.json({ code: 0, message: "上一轮分析仍在进行，跳过", data: null });
  }
  isRunning = true;
  const startedAt = Date.now();

  try {
    // 快照窗口：昨天往前 7 天（今天数据不全）
    const from = cstDateStr(-7);
    const to = cstDateStr(-1);
    const today = new Date(`${cstDateStr(0)}T00:00:00.000Z`);

    const campaigns = await prisma.campaigns.findMany({
      where: {
        is_deleted: 0,
        google_status: "ENABLED",
        NOT: [{ google_campaign_id: null }, { google_campaign_id: "" }],
      },
      select: {
        id: true,
        user_id: true,
        user_merchant_id: true,
        campaign_name: true,
        daily_budget: true,
        created_at: true,
      },
    });

    let created = 0, skipped = 0, failed = 0;
    const actionCounts: Record<string, number> = {};

    // 按用户分组：佣金查询按用户一次拉全（getCommissionFromTxn 按 user_merchant_id 分组）
    const byUser = new Map<string, typeof campaigns>();
    for (const c of campaigns) {
      const k = c.user_id.toString();
      if (!byUser.has(k)) byUser.set(k, []);
      byUser.get(k)!.push(c);
    }

    for (const [userIdStr, userCampaigns] of byUser) {
      const userId = BigInt(userIdStr);
      let commByMerchant: Awaited<ReturnType<typeof getCommissionFromTxn>>["byMerchant"];
      try {
        commByMerchant = (await getCommissionFromTxn(userId, from, to)).byMerchant;
      } catch (e) {
        console.error(`[CRON analyze-campaigns] user=${userIdStr} 佣金查询失败:`, e instanceof Error ? e.message : e);
        failed += userCampaigns.length;
        continue;
      }

      const stats = await prisma.ads_daily_stats.groupBy({
        by: ["campaign_id"],
        where: {
          campaign_id: { in: userCampaigns.map((c) => c.id) },
          date: { gte: dateColumnStart(from), lt: dateColumnEndExclusive(to) },
          is_deleted: 0,
        },
        _sum: { cost: true, clicks: true, impressions: true, orders: true },
      });
      const statByCampaign = new Map(stats.map((s) => [s.campaign_id.toString(), s._sum]));

      for (const c of userCampaigns) {
        try {
          const decisionId = buildDecisionId(c.id, today);
          const exists = await prisma.ad_decision_journal.count({ where: { decision_id: decisionId } });
          if (exists > 0) { skipped++; continue; }

          const s = statByCampaign.get(c.id.toString());
          const commData = c.user_merchant_id
            ? commByMerchant.get(c.user_merchant_id.toString())
            : undefined;
          const netCommission = commData ? commData.total - commData.rejected : 0;
          const daysRunning = c.created_at
            ? Math.floor((Date.now() - new Date(c.created_at).getTime()) / 86_400_000)
            : 0;

          const snapshot = buildSnapshot({
            spend: Number(s?.cost ?? 0),
            commission: netCommission,
            clicks: Number(s?.clicks ?? 0),
            orders: Number(s?.orders ?? 0),
            impressions: Number(s?.impressions ?? 0),
            dailyBudget: Number(c.daily_budget ?? 0),
            daysRunning,
          });
          const decision = decide(snapshot);

          await prisma.ad_decision_journal.create({
            data: {
              decision_id: decisionId,
              user_id: c.user_id,
              campaign_id: c.id,
              campaign_name: c.campaign_name || `ID-${c.id}`,
              snapshot_json: snapshot as unknown as object,
              action_type: decision.actionType,
              magnitude: decision.magnitude,
              reasoning: decision.reasoning,
            },
          });
          created++;
          actionCounts[decision.actionType] = (actionCounts[decision.actionType] ?? 0) + 1;
        } catch (e) {
          failed++;
          console.error(`[CRON analyze-campaigns] campaign=${c.id} 分析失败:`, e instanceof Error ? e.message : e);
        }
      }
    }

    const summary = {
      window: `${from} ~ ${to}`,
      campaigns: campaigns.length,
      created,
      skipped,
      failed,
      actions: actionCounts,
      elapsed_ms: Date.now() - startedAt,
    };
    console.log(`[CRON analyze-campaigns] ${JSON.stringify(summary)}`);
    return NextResponse.json({ code: 0, message: "ok", data: summary });
  } catch (e) {
    console.error("[CRON analyze-campaigns] 执行异常:", e instanceof Error ? e.message : e);
    return NextResponse.json(
      { code: -1, message: e instanceof Error ? e.message : "分析失败" },
      { status: 500 },
    );
  } finally {
    isRunning = false;
  }
}
