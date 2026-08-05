/**
 * C-089 ATC watchlist 每日扫描 cron 入口
 *
 * 调用方式：
 *   - GET（cron）：crontab 每天 08:00 CST 调用
 *       curl -sS -H "Authorization: Bearer $CRON_SECRET" http://localhost:20050/api/cron/atc-watchlist-scan
 *   - POST（手动）：开发/灰度时用 curl -X POST 同 URL
 *
 * 鉴权：CRON_SECRET（Authorization: Bearer ...）
 */
import { NextRequest, NextResponse } from "next/server";
import { scanAllWatchlists } from "@/lib/atc-watchlist-scanner";
import { syncAtcRecommendations, backfillAlertDomains } from "@/lib/atc-recommendation-sync";

function verifyCron(req: NextRequest): boolean {
  const secret = process.env.CRON_SECRET;
  if (!secret) return false;
  return req.headers.get("authorization") === `Bearer ${secret}`;
}

export async function GET(req: NextRequest) {
  if (!verifyCron(req)) {
    return NextResponse.json({ ok: false, error: "Unauthorized" }, { status: 401 });
  }
  const { searchParams } = new URL(req.url);
  const dryRun = searchParams.get("dry") === "1";
  // 只刷推荐、跳过扫描：回补和排障时用，免得白白烧掉 SerpApi 额度
  const syncOnly = searchParams.get("sync_only") === "1";
  const doBackfill = searchParams.get("backfill") === "1";

  try {
    let backfill: unknown = null;
    if (doBackfill) {
      backfill = await backfillAlertDomains();
      console.log(`[CRON atc-backfill ${new Date().toISOString()}] ${JSON.stringify(backfill)}`);
    }

    const result = syncOnly ? { skipped: "scan" as const } : await scanAllWatchlists();
    if (!syncOnly) {
      console.log(`[CRON atc-watchlist-scan ${new Date().toISOString()}] ${JSON.stringify(result)}`);
    }

    // D-213 扫完紧接着刷推荐商家，用的就是刚写进 alert_log 的数据。
    // 单独兜错：同步失败不能连累已经跑完的扫描结果，但要在返回里说清楚，不许静默。
    let recommendation: unknown = null;
    try {
      const rec = await syncAtcRecommendations({ dryRun });
      recommendation = rec;
      console.log(`[CRON atc-rec-sync ${new Date().toISOString()}] ${JSON.stringify(rec)}`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      recommendation = { error: msg };
      console.error(`[CRON atc-rec-sync ERROR] ${msg}`);
    }

    return NextResponse.json({ ok: true, ...result, backfill, recommendation });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[CRON atc-watchlist-scan ERROR] ${msg}`);
    return NextResponse.json({ ok: false, error: msg }, { status: 500 });
  }
}

export const POST = GET;
