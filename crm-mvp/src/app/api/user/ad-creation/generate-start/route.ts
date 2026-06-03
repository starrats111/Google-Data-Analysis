// ───────────────────────────────────────────────────────────────
// D-090：POST /api/user/ad-creation/generate-start
//
// 广告生成入口（后台任务版）：幂等创建/复用 ad_generation_jobs 行，
// 投入进程内后台 runner，立即返回 job_id。前端随后短轮询 /generate-status。
// 连接断/刷新/部署重启都不会丢结果（job 在后台跑完落库）。
//
// 灰度回滚：GENERATION_ASYNC_OFF=1 → 返回 { fallback:true }，前端回退到旧 SSE 链路
// （直接调用 /generate-extensions）。
// ───────────────────────────────────────────────────────────────

import { NextRequest } from "next/server";
import { getUserFromRequest } from "@/lib/auth";
import { apiError, apiSuccess } from "@/lib/constants";
import prisma from "@/lib/prisma";
import { createOrReuseGenerationJob, enqueueGenerationJob } from "@/lib/generation-runner";

export async function POST(req: NextRequest) {
  const user = getUserFromRequest(req);
  if (!user) return apiError("未授权", 401);

  let body: any;
  try {
    body = await req.json();
  } catch {
    return apiError("请求体格式错误");
  }
  const { campaign_id, types = [], ad_language, keywords = [] } = body;
  if (!campaign_id) return apiError("缺少 campaign_id");
  if (!Array.isArray(types) || !types.length) return apiError("缺少 types");

  // 灰度回滚：让前端走旧 SSE 链路
  if (process.env.GENERATION_ASYNC_OFF === "1") {
    return apiSuccess({ fallback: true });
  }

  // 轻量校验 campaign 归属，避免给非法请求建 job（完整上下文由 runner 在后台加载）
  const campaign = await prisma.campaigns.findFirst({
    where: { id: BigInt(campaign_id), user_id: BigInt(user.userId), is_deleted: 0 },
    select: { id: true },
  });
  if (!campaign) return apiError("广告系列不存在", 404);

  const job = await createOrReuseGenerationJob({
    campaignId: campaign.id,
    userId: BigInt(user.userId),
    payload: {
      types: types as string[],
      ad_language,
      keywords: keywords as string[],
      optionalTypes: (body.optionalTypes as string[]) || [],
    },
  });
  enqueueGenerationJob(job.id);

  return apiSuccess({ job_id: job.id.toString(), reused: job.reused });
}
