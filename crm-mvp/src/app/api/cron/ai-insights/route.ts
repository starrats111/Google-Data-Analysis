import { NextRequest, NextResponse } from "next/server";
import prisma from "@/lib/prisma";
import {
  generateDailyInsight,
  type DailyInsightMetrics,
  type DailyInsightCampaignRow,
  type DailyInsightAffiliatePlatform,
} from "@/lib/ai-service";

const CRON_SECRET = process.env.CRON_SECRET || "";

function verifyCron(req: NextRequest): boolean {
  if (!CRON_SECRET) return false;
  const auth = req.headers.get("authorization");
  return auth === `Bearer ${CRON_SECRET}`;
}

function log(msg: string) {
  console.log(`[CRON ai-insights ${new Date().toISOString()}] ${msg}`);
}

/**
 * GET /api/cron/ai-insights
 *
 * 每日 07:00 CST 执行：
 * Adrian · 数据猎手 对所有活跃用户昨日数据生成洞察报告
 */
export const dynamic = "force-dynamic";
export const maxDuration = 300;

export async function GET(req: NextRequest) {
  if (!verifyCron(req)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const force = req.nextUrl.searchParams.get("force") === "1";
  const userIdParam = req.nextUrl.searchParams.get("user_id");

  doAiInsights(force, userIdParam ? BigInt(userIdParam) : null)
    .catch((e) => log(`FATAL: ${e instanceof Error ? e.message : String(e)}`));

  return NextResponse.json({ ok: true, message: "ai insights generation started in background" });
}

async function doAiInsights(force = false, filterUserId: bigint | null = null) {
  log("开始 AI 洞察报告生成...");

  // 计算昨日日期（CST = UTC+8）
  const now = new Date();
  const cstNow = new Date(now.getTime() + 8 * 60 * 60 * 1000);
  const yesterday = new Date(cstNow);
  yesterday.setDate(yesterday.getDate() - 1);
  const dateStr = yesterday.toISOString().slice(0, 10); // "YYYY-MM-DD"
  const insightDate = new Date(dateStr + "T00:00:00.000Z");

  log(`目标日期: ${dateStr}`);

  // 查询所有活跃用户
  const whereClause: Parameters<typeof prisma.users.findMany>[0] = {
    where: {
      is_deleted: 0,
      ...(filterUserId ? { id: filterUserId } : {}),
    },
    select: { id: true, username: true },
  };
  const users = await (prisma.users as any).findMany(whereClause);
  log(`共 ${users.length} 个用户需要生成洞察`);

  let success = 0;
  let skip = 0;
  let fail = 0;

  for (const user of users) {
    try {
      // 跳过已生成（非强制刷新时）
      if (!force) {
        const existing = await prisma.ai_insights.findFirst({
          where: {
            user_id: user.id,
            insight_date: insightDate,
            insight_type: "daily",
            is_deleted: 0,
          },
          select: { id: true },
        });
        if (existing) {
          log(`用户 ${user.username} 已有 ${dateStr} 洞察，跳过`);
          skip++;
          continue;
        }
      }

      // 查询昨日广告数据（ads_daily_stats 无 campaign_name，需要 join campaigns）
      const adStats = await prisma.ads_daily_stats.findMany({
        where: {
          user_id: user.id,
          date: insightDate,
          is_deleted: 0,
        },
        select: {
          campaign_id: true,
          cost: true,
          clicks: true,
          impressions: true,
          commission: true,
          rejected_commission: true,
          orders: true,
          budget: true,
        },
      });

      // 查询 campaign 信息（name + status）
      const campaignIds = [...new Set(adStats.map((r) => r.campaign_id))];
      const campaignsInfo = campaignIds.length > 0
        ? await prisma.campaigns.findMany({
            where: { id: { in: campaignIds }, is_deleted: 0 },
            select: { id: true, campaign_name: true, status: true, daily_budget: true },
          })
        : [];
      const campaignMap = new Map(campaignsInfo.map((c) => [String(c.id), c]));

      // 查询昨日联盟收入
      // transaction_time 是 DateTime，按北京时间（CST=UTC+8）的昨日范围查询
      const txDateStart = new Date(dateStr + "T00:00:00.000Z"); // UTC 00:00 of yesterday
      const txDateEnd = new Date(dateStr + "T23:59:59.999Z");   // UTC 23:59 of yesterday
      const affiliateTx = await prisma.affiliate_transactions.findMany({
        where: {
          user_id: user.id,
          is_deleted: 0,
          transaction_time: { gte: txDateStart, lte: txDateEnd },
        },
        select: {
          platform: true,
          commission_amount: true,
          status: true,
          currency: true,
        },
      });

      // 构建核心指标
      const totalCost = adStats.reduce((s, r) => s + Number(r.cost ?? 0), 0);
      const totalClicks = adStats.reduce((s, r) => s + Number(r.clicks ?? 0), 0);
      const totalImpressions = adStats.reduce((s, r) => s + Number(r.impressions ?? 0), 0);
      const totalCommission = adStats.reduce((s, r) => s + Number(r.commission ?? 0), 0);
      const totalRejectedCommission = adStats.reduce((s, r) => s + Number(r.rejected_commission ?? 0), 0);

      // 联盟平台分布
      const platformMap: Record<string, DailyInsightAffiliatePlatform> = {};
      for (const tx of affiliateTx) {
        const platform = String(tx.platform || "unknown");
        const amt = Number(tx.commission_amount || 0);
        const status = String(tx.status || "").toLowerCase();
        if (!platformMap[platform]) {
          platformMap[platform] = {
            platform,
            total_commission: 0,
            rejected_commission: 0,
            pending_commission: 0,
            approved_commission: 0,
            orders: 0,
          };
        }
        platformMap[platform].total_commission += amt;
        platformMap[platform].orders++;
        if (status === "rejected" || status === "declined" || status === "invalid") {
          platformMap[platform].rejected_commission += amt;
        } else if (status === "pending" || status === "open") {
          platformMap[platform].pending_commission += amt;
        } else if (status === "approved" || status === "confirmed" || status === "paid") {
          platformMap[platform].approved_commission += amt;
        }
      }
      const affiliatePlatforms = Object.values(platformMap);

      // 从联盟数据补充佣金汇总（如 ad stats 无佣金数据）
      const txTotalCommission = affiliatePlatforms.reduce((s, p) => s + p.total_commission, 0);
      const txRejected = affiliatePlatforms.reduce((s, p) => s + p.rejected_commission, 0);
      const txPending = affiliatePlatforms.reduce((s, p) => s + p.pending_commission, 0);
      const txApproved = affiliatePlatforms.reduce((s, p) => s + p.approved_commission, 0);

      const finalCommission = totalCommission > 0 ? totalCommission : txTotalCommission;
      const roi = totalCost > 0 ? (finalCommission - totalCost) / totalCost : 0;

      const enabledCount = campaignsInfo.filter((c) => String(c.status || "").toUpperCase() === "ENABLED").length;
      const pausedCount = campaignsInfo.filter((c) => String(c.status || "").toUpperCase() === "PAUSED").length;

      const metrics: DailyInsightMetrics = {
        totalCost,
        totalCommission: finalCommission,
        totalRejectedCommission: totalRejectedCommission > 0 ? totalRejectedCommission : txRejected,
        totalApprovedCommission: txApproved,
        totalPendingCommission: txPending,
        totalClicks,
        totalImpressions,
        avgCpc: totalClicks > 0 ? totalCost / totalClicks : 0,
        roi,
        enabledCount,
        pausedCount,
        campaignCount: adStats.length,
      };

      const campaigns: DailyInsightCampaignRow[] = adStats.map((r) => {
        const campInfo = campaignMap.get(String(r.campaign_id));
        const cost = Number(r.cost ?? 0);
        const commission = Number(r.commission ?? 0);
        return {
          campaign_name: campInfo?.campaign_name || String(r.campaign_id),
          status: campInfo?.status || "UNKNOWN",
          cost,
          clicks: Number(r.clicks ?? 0),
          impressions: Number(r.impressions ?? 0),
          commission,
          rejected_commission: Number(r.rejected_commission ?? 0),
          orders: Number(r.orders ?? 0),
          roi: cost > 0 ? (commission - cost) / cost : 0,
          daily_budget: campInfo?.daily_budget != null ? Number(campInfo.daily_budget) : undefined,
        };
      });

      // 调用 AI 生成洞察报告
      const content = await generateDailyInsight({
        username: user.username,
        date: dateStr,
        metrics,
        campaigns,
        affiliatePlatforms,
      });

      const metricsSnapshot = {
        total_cost: totalCost,
        total_commission: finalCommission,
        roi: roi,
        total_clicks: totalClicks,
        total_impressions: totalImpressions,
        enabled_campaigns: metrics.enabledCount,
        paused_campaigns: metrics.pausedCount,
        platforms: affiliatePlatforms.map((p) => ({ platform: p.platform, commission: p.total_commission })),
      };

      // Upsert 洞察报告
      const existingForUpsert = await prisma.ai_insights.findFirst({
        where: { user_id: user.id, insight_date: insightDate, insight_type: "daily", is_deleted: 0 },
        select: { id: true },
      });

      if (existingForUpsert) {
        await prisma.ai_insights.update({
          where: { id: existingForUpsert.id },
          data: { content, metrics_snapshot: metricsSnapshot as any, updated_at: new Date() },
        });
      } else {
        await prisma.ai_insights.create({
          data: {
            user_id: user.id,
            insight_date: insightDate,
            insight_type: "daily",
            content,
            metrics_snapshot: metricsSnapshot as any,
            is_deleted: 0,
          },
        });
      }

      log(`用户 ${user.username} 洞察报告生成完成`);
      success++;
    } catch (err) {
      log(`用户 ${user.username} 洞察报告生成失败: ${err instanceof Error ? err.message : String(err)}`);
      fail++;
    }
  }

  log(`AI 洞察生成完成: 成功 ${success}，跳过 ${skip}，失败 ${fail}`);
}
