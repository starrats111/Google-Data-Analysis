// ───────────────────────────────────────────────────────────────
// GET /api/user/ad-creation/submit-status
//
// 短轮询读取提交 job 的状态/结果。免疫长连接断与 Cloudflare 边缘超时（每次都是独立短请求）。
//   - ?job_id=      按 job 读取
//   - ?campaign_id= 取该 campaign 最新 job（刷新/换设备接续未完成提交用）
// 返回 data：{ found, job_id, status, http_status, result, error }
//   result 为核心逻辑最终返回体 { code, message, data }，前端据此复用旧分支（成功/可覆盖/失败）。
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
    | Awaited<ReturnType<typeof prisma.ad_submit_jobs.findFirst>>
    | null = null;

  if (jobIdRaw) {
    try {
      job = await prisma.ad_submit_jobs.findFirst({
        where: { id: BigInt(jobIdRaw), user_id: BigInt(user.userId) },
      });
    } catch {
      return apiError("job_id 非法");
    }
  } else if (campaignIdRaw) {
    try {
      const cid = BigInt(campaignIdRaw);
      job = await prisma.ad_submit_jobs.findFirst({
        where: { campaign_id: cid, user_id: BigInt(user.userId), status: { in: ["queued", "running"] } },
        orderBy: { id: "desc" },
      });
      if (!job) {
        job = await prisma.ad_submit_jobs.findFirst({
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

  return apiSuccess({
    found: true,
    job_id: job.id.toString(),
    campaign_id: job.campaign_id.toString(),
    status: job.status,
    http_status: job.http_status,
    result: (job.result ?? null) as unknown,
    error: job.error,
    updated_at: job.updated_at ? new Date(job.updated_at).toISOString() : null,
  });
}
