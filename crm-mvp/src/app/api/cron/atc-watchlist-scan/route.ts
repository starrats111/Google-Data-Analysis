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

function verifyCron(req: NextRequest): boolean {
  const secret = process.env.CRON_SECRET;
  if (!secret) return false;
  return req.headers.get("authorization") === `Bearer ${secret}`;
}

export async function GET(req: NextRequest) {
  if (!verifyCron(req)) {
    return NextResponse.json({ ok: false, error: "Unauthorized" }, { status: 401 });
  }
  try {
    const result = await scanAllWatchlists();
    console.log(`[CRON atc-watchlist-scan ${new Date().toISOString()}] ${JSON.stringify(result)}`);
    return NextResponse.json({ ok: true, ...result });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[CRON atc-watchlist-scan ERROR] ${msg}`);
    return NextResponse.json({ ok: false, error: msg }, { status: 500 });
  }
}

export const POST = GET;
