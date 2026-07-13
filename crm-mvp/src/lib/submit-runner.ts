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
import { classifyJobForSweep, isJobFresh } from "@/lib/job-sweep-logic";

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
    if (isJobFresh(existing, Date.now(), STALE_MS)) {
      // 2026-07-13（第七轮）P0：复用 queued job 时用最新 payload 覆盖——
      // 用户改完文案再点提交却复用旧 payload，会把改前的旧文案发到 Google。
      // running 状态的 job 已在执行，payload 无法中途替换，只能原样复用。
      if (existing.status === "queued") {
        await prisma.ad_submit_jobs
          .update({ where: { id: existing.id }, data: { payload: payload as object } })
          .catch(() => {});
      }
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

  // 2026-07-13（第七轮）P0：并发双击竞态双检——两个 POST 同时走到「无活跃 job」后各建一行。
  // 建完再查一次：若存在比自己更早的活跃 job，废弃自己、复用更早那个（双击场景 payload 相同）。
  const race = await prisma.ad_submit_jobs.findFirst({
    where: { campaign_id: campaignId, status: { in: ["queued", "running"] }, id: { lt: job.id } },
    orderBy: { id: "asc" },
  });
  if (race && isJobFresh(race, Date.now(), STALE_MS)) {
    await prisma.ad_submit_jobs
      .update({ where: { id: job.id }, data: { status: "failed", error: "并发重复提交，已合并到更早的任务" } })
      .catch(() => {});
    return { id: race.id, reused: true };
  }
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

  // 2026-07-13（第七轮）P0：同 campaign 已有另一个心跳新鲜的 running job → 本 job 先不跑
  //（保持 queued，等 sweeper 下个周期再看）。防止恢复/扫队与正常执行对同一 campaign 并发 mutate。
  const staleBefore = new Date(Date.now() - STALE_MS);
  const sibling = await prisma.ad_submit_jobs.findFirst({
    where: {
      campaign_id: job.campaign_id,
      status: "running",
      id: { not: jobId },
      heartbeat_at: { gte: staleBefore },
    },
    select: { id: true },
  }).catch(() => null);
  if (sibling) {
    console.warn(`[SubmitRunner] job=${jobId} 同 campaign 已有 running job=${sibling.id}，本次跳过`);
    return;
  }

  // 2026-07-13（第七轮）P0：CAS 认领——只允许「queued → running」或「僵死 running 再认领」。
  // 旧逻辑无条件 update，两个进程（启动恢复 + cron 扫队）可同时把同一 job 置 running 并双跑。
  const claimed = await prisma.ad_submit_jobs.updateMany({
    where: {
      id: jobId,
      OR: [
        { status: "queued" },
        { status: "running", heartbeat_at: { lt: staleBefore } },
        { status: "running", heartbeat_at: null },
      ],
    },
    data: { status: "running", attempt: { increment: 1 }, heartbeat_at: new Date() },
  }).catch(() => ({ count: 0 }));
  if (claimed.count === 0) {
    console.warn(`[SubmitRunner] job=${jobId} 已被其他进程认领（心跳新鲜），本次跳过`);
    return;
  }

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
    // 终态 CAS：仅 queued/running 可写 done，避免僵尸执行流覆盖已被外部标 failed 的 job
    await prisma.ad_submit_jobs
      .updateMany({
        where: { id: jobId, status: { in: ["queued", "running"] } },
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
  // CAS：已 done 的 job 不允许再被标 failed（恢复/扫队与正常完成竞态时保护终态）
  await prisma.ad_submit_jobs
    .updateMany({
      where: { id: jobId, status: { in: ["queued", "running"] } },
      data: {
        status: "failed",
        http_status: 500,
        error: (message || "提交失败").slice(0, 1000),
        result: { code: -1, message: (message || "提交失败").slice(0, 800) } as unknown as object,
        heartbeat_at: new Date(),
      },
    })
    .catch(() => {});
  // 提交 job 走到最终失败 = 广告没发出去且不会再自动重试，外部告警让人立刻介入
  try {
    const { sendAlert } = await import("@/lib/alert");
    void sendAlert({
      level: "error",
      title: `广告提交任务最终失败 job=${jobId}`,
      content: (message || "提交失败").slice(0, 400),
      source: "submit-runner",
    });
  } catch { /* 告警失败不影响主流程 */ }
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

/**
 * DB 驱动扫队（由 /api/cron/job-sweeper 周期调用）：
 * 把「queued 但没被任何进程捡起」和「running 但心跳超时（进程崩溃/重启丢失）」的 job
 * 重新入队；超尝试次数上限的判失败。使 job 兜底恢复不再只依赖模块加载时的单次
 * recoverInterruptedSubmitJobs——任何时刻掉队的 job 最迟一个 cron 周期内被扫起。
 * 同进程内 inFlight 去重保证对正在跑的 job 重复 enqueue 是 no-op。
 */
export async function sweepSubmitJobs(): Promise<{ scanned: number; requeued: number; failed: number }> {
  const stats = { scanned: 0, requeued: 0, failed: 0 };
  const candidates = await prisma.ad_submit_jobs.findMany({
    where: { status: { in: ["queued", "running"] } },
    orderBy: { id: "asc" },
    take: 50,
  });
  const now = Date.now();
  for (const job of candidates) {
    stats.scanned++;
    const decision = classifyJobForSweep(job, {
      now,
      staleMs: STALE_MS,
      maxAttempt: MAX_ATTEMPT,
      inFlight: inFlight.has(job.id.toString()),
    });
    if (decision === "skip") continue;
    if (decision === "fail") {
      await finalizeFailed(job.id, "任务多次中断后仍未完成，请到数据中心确认广告是否已创建");
      stats.failed++;
      continue;
    }
    console.warn(`[SubmitRunner] sweeper 重新入队 job=${job.id} status=${job.status} attempt=${job.attempt}`);
    enqueueSubmitJob(job.id);
    stats.requeued++;
  }
  return stats;
}

// 模块首次加载即触发一次启动恢复（延迟一点，确保 DB 连接就绪）。
setTimeout(() => {
  void recoverInterruptedSubmitJobs();
}, 5_000).unref?.();
