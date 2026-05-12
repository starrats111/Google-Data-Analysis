/**
 * C-088 OCR Worker Cron 端点
 *
 * 调用方式：
 *   - GET（cron）：crontab `*\/5 * * * * curl -sS http://localhost:20050/api/cron/ocr-worker -H "Authorization: Bearer $CRON_SECRET"`
 *   - POST（手动）：开发调试时用 curl -X POST 同 URL
 *
 * 鉴权：CRON_SECRET（Authorization: Bearer ...）
 *
 * 行为：runOcrWorker()
 *   - 全局开关关 / 无 domain_ocr scene → skipped
 *   - 拉一批 pending，并发跑 vision API，回写 cache
 */
import { NextRequest, NextResponse } from "next/server";
import { runOcrWorker } from "@/lib/ocr-domain";

function verifyCron(req: NextRequest): boolean {
  const secret = process.env.CRON_SECRET;
  if (!secret) return false;
  return req.headers.get("authorization") === `Bearer ${secret}`;
}

export async function GET(req: NextRequest) {
  if (!verifyCron(req)) {
    return NextResponse.json({ ok: false, error: "Unauthorized" }, { status: 401 });
  }
  const startedAt = Date.now();
  try {
    const result = await runOcrWorker();
    const elapsedMs = Date.now() - startedAt;
    console.log(`[CRON ocr-worker ${new Date().toISOString()}] ${JSON.stringify(result)} (${elapsedMs}ms)`);
    return NextResponse.json({ ok: true, ...result, elapsedMs });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[CRON ocr-worker ERROR] ${msg}`);
    return NextResponse.json({ ok: false, error: msg }, { status: 500 });
  }
}

export const POST = GET;
