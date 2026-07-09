/**
 * GET /api/cron/job-sweeper - 后台任务扫队兜底
 *
 * submit-runner / generation-runner 是 PM2 单进程内存队列：job 入队依赖「收到请求的
 * 那个进程活着」，进程崩溃/重启后仅靠模块加载时的单次启动恢复。本 cron 周期性扫
 * ad_submit_jobs / ad_generation_jobs，把掉队的 queued/僵死 running job 重新入队，
 * 超尝试上限的判失败——任何掉队 job 最迟一个 cron 周期内被扫起。
 *
 * crontab 示例（服务器，每 2 分钟；星 = 星号）：
 *   星/2 * * * * curl -s -H 'Authorization: Bearer ${CRON_SECRET}' 'http://localhost:20050/api/cron/job-sweeper' >> /var/log/crm-cron/job-sweeper.log 2>&1
 *
 * 鉴权：CRON_SECRET（Authorization: Bearer ...）
 */

import { NextRequest, NextResponse } from "next/server";
import { sweepSubmitJobs } from "@/lib/submit-runner";
import { sweepGenerationJobs } from "@/lib/generation-runner";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

let isRunning = false;

function verifyCron(req: NextRequest): boolean {
  const secret = process.env.CRON_SECRET;
  if (!secret) return false;
  return req.headers.get("authorization") === `Bearer ${secret}`;
}

export async function GET(req: NextRequest) {
  if (!verifyCron(req)) {
    return NextResponse.json({ code: -1, message: "未授权" }, { status: 401 });
  }
  if (isRunning) {
    return NextResponse.json({ code: 0, message: "上一轮扫队仍在进行，跳过", data: null });
  }
  isRunning = true;
  try {
    const submit = await sweepSubmitJobs();
    const generation = await sweepGenerationJobs();
    const summary = { submit, generation };
    if (submit.requeued + submit.failed + generation.requeued + generation.failed > 0) {
      console.warn(`[CRON job-sweeper] ${JSON.stringify(summary)}`);
    }
    return NextResponse.json({ code: 0, message: "ok", data: summary });
  } catch (e) {
    console.error("[CRON job-sweeper] 执行异常:", e instanceof Error ? e.message : e);
    return NextResponse.json(
      { code: -1, message: e instanceof Error ? e.message : "扫队失败" },
      { status: 500 },
    );
  } finally {
    isRunning = false;
  }
}
