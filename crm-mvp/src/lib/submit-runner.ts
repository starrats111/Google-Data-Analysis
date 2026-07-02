// ───────────────────────────────────────────────────────────────
// 广告提交后台任务 runner
//
// 把 /api/user/ad-creation/submit 从「长连接同步请求」解耦为「后台任务 + 短轮询」：
//   - submit(POST) 轻校验后 createOrReuseSubmitJob 建/复用 ad_submit_jobs 行并 enqueue，
//     立即返回 job_id；不再在请求内跑 2min+ 的合规返工/图片/Google mutate。
//   - 本 runner 在进程内后台跑 runSubmitJobById：动态 import submit route 的 runSubmitCore，
//     拿到 Response 后 .json() 出 { code, message, data } 落库到 result，并记 http_status。
//   - 前端轮询 /submit-status 读 result，连接断/刷新/Cloudflare 边缘超时都不影响结果落库。
//   - 幂等：同 campaign 存在 queued|running 且新鲜的 job → 复用（防重复点击多提交）。
//   - 重跑安全：submit 核心自带「campaign.google_campaign_id 已存在则拒绝」+ reconcileIfExistsInGoogle
//     （按同名系列对账采纳），故重启恢复重跑不会在 Google 端重复建广告。
// ───────────────────────────────────────────────────────────────

import prisma from "@/lib/prisma";

// submit 核心单次可达 2-3min；给 6min 才判僵死，避免长任务被误判为僵死而重复建 job。
const STALE_MS = 360_000;
// 单 job 最多尝试次数：重启恢复最多再跑 1 次（核心有对账兜底，不会重复建广告）。
const MAX_ATTEMPT = 2;
// 运行期心跳间隔：长任务期间定期 bump heartbeat，保证 STALE 判定准确。
const HEARTBEAT_MS = 30_000;

// 进程内「正在跑」的 jobId 去重（同进程内同一 job 只跑一份）。
const inFlight = new Set<string>();

export interface SubmitJobResult {
  code: number;
  message?: string;
  data?: unknown;
}

/**
 * 幂等创建/复用一个提交 job。
 * 复用规则：同 campaign 存在 queued|running 且心跳/创建新鲜的 job → 直接复用（防重复点击多提交）。
 * 僵死的旧 job 标记 failed 后重建。
 */
export async function createOrReuseSubmitJob(args: {
  campaignId: bigint;
  userId: bigint;
  payload: unknown;
}): Promise<{ id: bigint; reused: boolean }> {
  const { campaignId, userId, payload } = args;

  const actives = await prisma.ad_submit_jobs.findMany({
    where: { campaign_id: campaignId, status: { in: ["queued", "running"] } },
    orderBy: { id: "desc" },
    take: 5,
  });
  const existing = actives[0];
  if (existing) {
    const hbFresh = existing.heartbeat_at
      ? Date.now() - new Date(existing.heartbeat_at).getTime() < STALE_MS
      : false;
    const justCreated = Date.now() - new Date(existing.created_at).getTime() < STALE_MS;
    if (hbFresh || justCreated) {
      return { id: existing.id, reused: true };
    }
    // 僵死的旧 running/queued job（进程可能已重启）：标记 failed，重建新的。
    await prisma.ad_submit_jobs
      .update({ where: { id: existing.id }, data: { status: "failed", error: "任务僵死，已重建" } })
      .catch(() => {});
  }

  const job = await prisma.ad_submit_jobs.create({
    data: {
      campaign_id: campaignId,
      user_id: userId,
      payload: payload as object,
      status: "queued",
      heartbeat_at: new Date(),
    },
  });
  return { id: job.id, reused: false };
}

/**
 * 把 job 投入后台执行（非阻塞）。同进程内对同一 job 幂等：已在跑则 no-op。
 */
export function enqueueSubmitJob(jobId: bigint): void {
  const key = jobId.toString();
  if (inFlight.has(key)) return;
  inFlight.add(key);
  void runSubmitJobById(jobId).finally(() => inFlight.delete(key));
}

/**
 * 后台执行一个提交 job：调用 submit route 的 runSubmitCore，把结果落库。
 */
export async function runSubmitJobById(jobId: bigint): Promise<void> {
  const job = await prisma.ad_submit_jobs.findUnique({ where: { id: jobId } });
  if (!job) return;
  if (job.status === "done" || job.status === "failed") return;

  await prisma.ad_submit_jobs
    .update({
      where: { id: jobId },
      data: { status: "running", attempt: { increment: 1 }, heartbeat_at: new Date() },
    })
    .catch(() => {});

  // 运行期心跳：长任务期间定期 bump，避免被 createOrReuse 误判僵死而重复建 job。
  const hb = setInterval(() => {
    void prisma.ad_submit_jobs
      .update({ where: { id: jobId }, data: { heartbeat_at: new Date() } })
      .catch(() => {});
  }, HEARTBEAT_MS);
  hb.unref?.();

  try {
    // 动态导入，避免与 route 模块形成静态循环依赖。
    const mod = await import("@/app/api/user/ad-creation/submit/route");
    const resp = await mod.runSubmitCore(job.user_id, job.payload);
    let result: SubmitJobResult;
    try {
      result = (await resp.json()) as SubmitJobResult;
    } catch {
      result = { code: -1, message: "提交结果解析失败" };
    }
    await prisma.ad_submit_jobs
      .update({
        where: { id: jobId },
        data: {
          status: "done",
          http_status: resp.status,
          result: result as unknown as object,
          error: result.code === 0 ? null : (result.message ?? "").slice(0, 1000) || null,
          heartbeat_at: new Date(),
        },
      })
      .catch((e) => console.warn(`[SubmitRunner] job=${jobId} 落库失败:`, e instanceof Error ? e.message : e));
    console.warn(`[SubmitRunner] job=${jobId} 完成 http=${resp.status} code=${result.code}`);
  } catch (e) {
    console.error(`[SubmitRunner] job=${jobId} 执行异常:`, e instanceof Error ? e.message : e);
    await finalizeFailed(jobId, e instanceof Error ? e.message : String(e));
  } finally {
    clearInterval(hb);
  }
}

async function finalizeFailed(jobId: bigint, message: string): Promise<void> {
  await prisma.ad_submit_jobs
    .update({
      where: { id: jobId },
      data: {
        status: "failed",
        http_status: 500,
        error: (message || "提交失败").slice(0, 1000),
        result: { code: -1, message: (message || "提交失败").slice(0, 800) } as unknown as object,
        heartbeat_at: new Date(),
      },
    })
    .catch(() => {});
}

/**
 * 启动恢复：把卡在 running/queued 的 job 重新入队。
 * 部署重启后进程内队列丢失，但 job 行仍在。submit 核心自带同名系列对账 + 已提交守卫，
 * 重跑不会在 Google 端重复建广告。超尝试次数上限的直接判失败，避免无限重跑。
 */
let recoveryRan = false;
export async function recoverInterruptedSubmitJobs(): Promise<void> {
  if (recoveryRan) return;
  recoveryRan = true;
  try {
    const stuck = await prisma.ad_submit_jobs.findMany({
      where: { status: { in: ["running", "queued"] } },
      orderBy: { id: "asc" },
      take: 20,
    });
    if (stuck.length === 0) return;
    console.warn(`[SubmitRunner] 启动恢复：发现 ${stuck.length} 个未完成 job`);
    for (const job of stuck) {
      if ((job.attempt ?? 0) >= MAX_ATTEMPT) {
        await finalizeFailed(job.id, "服务重启后多次重试仍失败，请到数据中心确认广告是否已创建");
        continue;
      }
      console.warn(`[SubmitRunner] 重新入队 job=${job.id} campaign=${job.campaign_id} attempt=${job.attempt}`);
      enqueueSubmitJob(job.id);
    }
  } catch (e) {
    console.warn("[SubmitRunner] 启动恢复失败:", e instanceof Error ? e.message : e);
  }
}

// 模块首次加载即触发一次启动恢复（延迟一点，确保 DB 连接就绪）。
setTimeout(() => {
  void recoverInterruptedSubmitJobs();
}, 5_000).unref?.();
