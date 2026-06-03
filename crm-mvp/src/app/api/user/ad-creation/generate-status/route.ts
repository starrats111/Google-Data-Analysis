// ───────────────────────────────────────────────────────────────
// D-090：GET /api/user/ad-creation/generate-status
//
// 短轮询读取生成 job 的进度/结果快照。免疫长连接断（每次都是独立短请求）。
//   - ?job_id=  按 job 读取
//   - ?campaign_id=  取该 campaign 最新 job（进页自动接续未完成任务用）
// 返回：{ found, job_id, status, stage, progress, seq, events, error }
//   events 为 { [事件类型]: data } 快照（latest-wins），前端按 seq 变化增量 handleEvent。
// ───────────────────────────────────────────────────────────────

import { NextRequest } from "next/server";
import { getUserFromRequest } from "@/lib/auth";
import { apiError, apiSuccess } from "@/lib/constants";
import prisma from "@/lib/prisma";

export async function GET(req: NextRequest) {
  const user = getUserFromRequest(req);
  if (!user) return apiError("未授权", 401);

  const { searchParams } = new URL(req.url);
  const jobIdRaw = searchParams.get("job_id");
  const campaignIdRaw = searchParams.get("campaign_id");

  let job:
    | Awaited<ReturnType<typeof prisma.ad_generation_jobs.findFirst>>
    | null = null;

  if (jobIdRaw) {
    try {
      job = await prisma.ad_generation_jobs.findFirst({
        where: { id: BigInt(jobIdRaw), user_id: BigInt(user.userId) },
      });
    } catch {
      return apiError("job_id 非法");
    }
  } else if (campaignIdRaw) {
    try {
      const cid = BigInt(campaignIdRaw);
      // 进页自动接续：优先返回正在进行(queued|running)的 job；否则返回最近一条
      job = await prisma.ad_generation_jobs.findFirst({
        where: { campaign_id: cid, user_id: BigInt(user.userId), status: { in: ["queued", "running"] } },
        orderBy: { id: "desc" },
      });
      if (!job) {
        job = await prisma.ad_generation_jobs.findFirst({
          where: { campaign_id: cid, user_id: BigInt(user.userId) },
          orderBy: { id: "desc" },
        });
      }
    } catch {
      return apiError("campaign_id 非法");
    }
  } else {
    return apiError("缺少 job_id 或 campaign_id");
  }

  if (!job) return apiSuccess({ found: false });

  const result = (job.result ?? {}) as { events?: Record<string, unknown>; seq?: number };
  return apiSuccess({
    found: true,
    job_id: job.id.toString(),
    campaign_id: job.campaign_id.toString(),
    status: job.status,
    stage: job.stage,
    progress: job.progress,
    seq: result.seq ?? 0,
    events: result.events ?? {},
    error: job.error,
    // 进页自动接续用：原始请求载荷（types / optionalTypes）
    request: (job.types ?? {}) as unknown,
    updated_at: job.updated_at ? new Date(job.updated_at).toISOString() : null,
  });
}
