/**
 * GET /api/cron/brand-assessment — 品牌评估任务执行器
 *
 * 员工在「广告情报 → 品牌评估」提交的任务只落一行 pending，真正的执行在这里：
 * 单个国家要打 SerpApi 的 serp / trends / 广告透明中心 / autocomplete 四个接口再交 LLM 评估，
 * 几十秒起步，不能放在 HTTP 请求里跑。
 *
 * 抢占由 `claimPendingJob` 的原子 UPDATE 保证，多进程同时打这个端点也不会重复执行同一任务。
 * 每 tick 最多 3 个任务：服务器是 2 核 3.7G，SerpApi 也有并发上限，宁可多跑几个周期。
 *
 * crontab 示例（每 2 分钟；星 = 星号）：
 *   星/2 * * * * curl -s -H 'Authorization: Bearer ${CRON_SECRET}' 'http://localhost:20050/api/cron/brand-assessment' >> /var/log/crm-cron/brand-assessment.log 2>&1
 */
import { NextRequest, NextResponse } from "next/server";
import { runCronTick } from "@/lib/rival-intel/brand-assessment/cron-runner";
import {
  createBrandAssessmentHttpGet,
  defaultLlmCaller,
} from "@/lib/rival-intel/brand-assessment/wiring";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

let isRunning = false;

export async function GET(req: NextRequest) {
  const secret = process.env.CRON_SECRET;
  if (!secret || req.headers.get("authorization") !== `Bearer ${secret}`) {
    return NextResponse.json({ code: -1, message: "未授权" }, { status: 401 });
  }
  if (isRunning) {
    return NextResponse.json({ code: 0, message: "上一轮仍在执行，跳过", data: null });
  }

  isRunning = true;
  try {
    const summary = await runCronTick({
      httpGet: createBrandAssessmentHttpGet(),
      llmCaller: defaultLlmCaller,
      maxJobs: 3,
    });
    if (summary.processed > 0) {
      console.warn(`[CRON brand-assessment] ${JSON.stringify(summary)}`);
    }
    return NextResponse.json({ code: 0, message: "ok", data: summary });
  } catch (e) {
    console.error("[CRON brand-assessment] 执行异常:", e instanceof Error ? e.message : e);
    return NextResponse.json(
      { code: -1, message: e instanceof Error ? e.message : "执行失败" },
      { status: 500 },
    );
  } finally {
    isRunning = false;
  }
}
