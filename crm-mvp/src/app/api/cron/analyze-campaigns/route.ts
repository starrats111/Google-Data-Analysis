import { NextRequest, NextResponse } from "next/server";
import prisma from "@/lib/prisma";
import { analyzeCampaigns, getAnalysisRange } from "@/lib/campaign-analysis";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

/**
 * D-238 每日广告 AI 分析（06:40，排在 06:00 昨日数据同步 + 06:10 指标采集之后）
 *
 * 对每个用户最近 7 天有花费的 ENABLED 系列跑快速批量分析（平衡版策略），
 * 结果 upsert 到 ai_recommendations，数据中心「操作建议」列直接读缓存。
 * forceRefresh=true：每天重算一次，覆盖昨日窗口的旧结果。
 *
 * 逐用户串行（低配生产机 + AI 网关限流双重考虑），单用户失败不阻塞其他。
 */

function verifyCron(req: NextRequest): boolean {
  const secret = process.env.CRON_SECRET;
  if (!secret) return false;
  return req.headers.get("authorization") === `Bearer ${secret}`;
}

function log(msg: string) {
  console.error(`[CRON analyze-campaigns ${new Date().toISOString()}] ${msg}`);
}

export async function GET(req: NextRequest) {
  if (!verifyCron(req)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const startedAt = Date.now();
  const range = getAnalysisRange(7);

  // 窗口内有花费的系列 → 按用户分组
  const activeStats = await prisma.ads_daily_stats.findMany({
    where: {
      is_deleted: 0,
      date: { gte: range.dateStart, lt: range.dateEndExclusive },
      cost: { gt: 0 },
    },
    select: { user_id: true, campaign_id: true },
    distinct: ["campaign_id"],
  });

  const byUser = new Map<string, bigint[]>();
  for (const s of activeStats) {
    const key = String(s.user_id);
    const arr = byUser.get(key) || [];
    arr.push(s.campaign_id);
    byUser.set(key, arr);
  }

  const stats = { users: 0, campaigns: 0, generated: 0, failed: 0, errors: [] as string[] };

  for (const [userIdStr, campaignIds] of byUser) {
    const userId = BigInt(userIdStr);
    // 只分析 ENABLED 系列（暂停/移除的没有当下调整意义，用户可手动单独分析）
    const enabled = await prisma.campaigns.findMany({
      where: { id: { in: campaignIds }, user_id: userId, is_deleted: 0, google_status: "ENABLED" },
      select: { id: true },
    });
    if (enabled.length === 0) continue;

    stats.users++;
    stats.campaigns += enabled.length;
    try {
      const result = await analyzeCampaigns({
        userId,
        campaignIds: enabled.map((c) => c.id),
        strategy: "balanced",
        forceRefresh: true,
        detailed: false,
      });
      if (!result.configured) {
        stats.errors.push("分析提示词未配置，本轮跳过全部用户");
        log("分析提示词未配置（system_configs 缺 campaign_ad_analysis_main_prompt / aux），终止");
        break;
      }
      for (const item of result.items) {
        if (item.status === "generated" || item.status === "cached") stats.generated++;
        else stats.failed++;
      }
    } catch (err) {
      const msg = `user=${userIdStr}: ${err instanceof Error ? err.message : String(err)}`;
      stats.errors.push(msg.slice(0, 300));
      log(`分析失败 ${msg}`);
    }
  }

  log(`完成：用户 ${stats.users}、系列 ${stats.campaigns}、成功 ${stats.generated}、失败 ${stats.failed}，耗时 ${((Date.now() - startedAt) / 1000).toFixed(1)}s`);
  return NextResponse.json({ ok: true, ...stats, elapsedSec: (Date.now() - startedAt) / 1000 });
}
