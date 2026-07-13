// ───────────────────────────────────────────────────────────────
// D-090：广告生成后台任务 runner
//
// 把广告生成从"长连接 SSE 请求"解耦为"后台任务 + 短轮询"：
//   - generate-start 创建/复用 ad_generation_jobs 行并 enqueueGenerationJob(jobId)
//   - 本 runner 在进程内后台跑 runGenerationJobById：复用 generate-extensions 的
//     buildGenerationStream(同一条流水线)，但不把流回给客户端，而是 consumeStreamIntoJob
//     把每个 SSE 事件解析后去抖落库到 ad_generation_jobs.result
//   - 前端轮询 generate-status 读取 result 快照，连接断/刷新/换设备都不丢结果
//   - 并发仍由 generate-extensions 内部的 generation-gate(=2) 约束，本 runner 不额外开并发
//   - 启动恢复：模块加载时把卡在 running/queued 的 job 重新入队（爬取/画像 7 天缓存命中→快且省）
// ───────────────────────────────────────────────────────────────

import prisma from "@/lib/prisma";
import { classifyJobForSweep, isJobFresh } from "@/lib/job-sweep-logic";

// 与 generate-extensions/route.ts 的 GenerationRequestPayload 同构（此处本地定义避免静态循环依赖）
export interface GenerationRequestPayload {
  types: string[];
  ad_language?: string | null;
  keywords?: string[];
  optionalTypes?: string[];
  forceRecrawl?: boolean;
}

// 判定 job 僵死的阈值：心跳/创建超过此时长仍未结束，视为可重建/可恢复。
// D-160：90s → 300s。爬虫阶段最长 165s 无事件 + D-101 巡航 60s 无事件，90s 会把健康 job
// 误判僵死：刷新页面 → generate-start 标旧 job failed 并重建 → 旧 job 下次落库又复活为 running
// → 同 campaign 双流水线并行（爬虫/AI 全双份）。配合下方周期心跳，300s 只兜真正的进程崩溃。
const STALE_MS = 300_000;
// 单 job 最多尝试次数，防止启动恢复无限重跑
const MAX_ATTEMPT = 3;
// 落库去抖间隔
const FLUSH_MS = 600;

// 事件类型 → 阶段/进度（仅用于前端进度提示，progress 只增不减）
const STAGE_MAP: Record<string, { stage: string; progress: number }> = {
  queued: { stage: "queued", progress: 4 },
  crawl_pending: { stage: "crawling", progress: 12 },
  crawl_status: { stage: "analyzing", progress: 30 },
  detected_language: { stage: "analyzing", progress: 32 },
  keywords_pending: { stage: "analyzing", progress: 34 },
  keywords: { stage: "analyzing", progress: 38 },
  keywords_failed: { stage: "analyzing", progress: 38 },
  headlines: { stage: "generating", progress: 55 },
  descriptions: { stage: "generating", progress: 65 },
  callouts: { stage: "generating", progress: 70 },
  structured_snippet: { stage: "generating", progress: 72 },
  sitelinks: { stage: "sitelinks", progress: 80 },
  images: { stage: "images", progress: 88 },
  core_done: { stage: "finalizing", progress: 92 },
};

// 视为"有实质产出"的事件（决定终态是 done 还是 failed；含两种诚实失败提示，也算 done 让前端展示具体原因）
const CONTENT_EVENT_KEYS = [
  "headlines", "descriptions", "sitelinks", "images", "call", "promotion",
  "price_items", "callouts", "structured_snippet", "negative_keywords",
  "merchant_url_parked", "context_insufficient",
];

// 进程内"正在跑"的 jobId 去重（同一进程内同一 job 只跑一份）
const inFlight = new Set<string>();

// 请求载荷签名：同 campaign 下不同 types/optionalTypes 是不同的并行 job（core / optional / sitelinks），
// 仅当签名相同才视为"重复点击同一生成"而复用。
function payloadSignature(p: GenerationRequestPayload): string {
  // 2026-07-13（第五轮）：签名补 ad_language / keywords / forceRecrawl。
  // 此前只有 types——员工改了关键词或广告语言后 5 分钟内再点生成，会复用旧 job 回放旧参数，
  // 新关键词/新语言被无视；「重新爬取」也会被并入普通生成 job。
  return JSON.stringify({
    t: [...(p.types || [])].sort(),
    o: [...(p.optionalTypes || [])].sort(),
    l: (p.ad_language || "").toLowerCase(),
    k: [...(p.keywords || [])].map((s) => String(s).trim().toLowerCase()).filter(Boolean).sort(),
    f: p.forceRecrawl ? 1 : 0,
  });
}

// 2026-07-13（第七轮）P0：泳道签名——只看 types/optionalTypes。
// 同泳道（如都是 core 生成）但参数不同（改了关键词/语言/勾了重新爬取）的两个 job
// 绝不能并行跑（两条完整爬虫+AI 流水线互相竞争、烧双份资源、结果互相覆盖）。
// 互斥粒度用泳道，复用判定仍用完整签名：参数变了 → 旧 job 让位、新 job 接管。
function laneSignature(p: GenerationRequestPayload): string {
  return JSON.stringify({
    t: [...(p.types || [])].sort(),
    o: [...(p.optionalTypes || [])].sort(),
  });
}

// 2026-07-13：创建互斥。findMany(检查)→create(创建) 不是原子操作——双击/前端重试
// 两个请求同时通过"无活跃 job"检查后各建一个 job，两条完整流水线（爬虫+AI）并行烧资源。
// 用 campaignId+签名 的进程内 promise 链把 check-and-create 串行化（单实例部署下即全局互斥）。
const _jobCreateChain = new Map<string, Promise<unknown>>();

/**
 * 幂等创建/复用一个生成 job。
 * 复用规则：同 campaign + 相同请求签名 存在 queued|running 且心跳/创建新鲜的 job → 直接复用（防重复点击多开）。
 * 僵死的旧 job 标记 failed 后重建。
 */
export async function createOrReuseGenerationJob(args: {
  campaignId: bigint;
  userId: bigint;
  payload: GenerationRequestPayload;
}): Promise<{ id: bigint; reused: boolean }> {
  const { campaignId, userId, payload } = args;
  const sig = payloadSignature(payload);
  // 互斥粒度 = 泳道（types/optionalTypes），防止同泳道不同参数的 job 并行双跑
  const mutexKey = `${campaignId}:${laneSignature(payload)}`;

  const prev = _jobCreateChain.get(mutexKey) ?? Promise.resolve();
  const task = prev
    .catch(() => {}) // 前一个失败不影响后续
    .then(() => createOrReuseGenerationJobInner(campaignId, userId, payload, sig));
  _jobCreateChain.set(mutexKey, task);
  task.finally(() => {
    if (_jobCreateChain.get(mutexKey) === task) _jobCreateChain.delete(mutexKey);
  }).catch(() => {});
  return task;
}

async function createOrReuseGenerationJobInner(
  campaignId: bigint,
  userId: bigint,
  payload: GenerationRequestPayload,
  sig: string,
): Promise<{ id: bigint; reused: boolean }> {
  const laneSig = laneSignature(payload);
  const actives = await prisma.ad_generation_jobs.findMany({
    where: { campaign_id: campaignId, status: { in: ["queued", "running"] } },
    orderBy: { id: "desc" },
    take: 10,
  });
  const safeSig = (j: { types: unknown }) => {
    try {
      return payloadSignature((j.types ?? {}) as unknown as GenerationRequestPayload);
    } catch {
      return "";
    }
  };
  const safeLane = (j: { types: unknown }) => {
    try {
      return laneSignature((j.types ?? {}) as unknown as GenerationRequestPayload);
    } catch {
      return "";
    }
  };
  const existing = actives.find((j) => safeSig(j) === sig);
  if (existing) {
    if (isJobFresh(existing, Date.now(), STALE_MS)) {
      return { id: existing.id, reused: true };
    }
    // 僵死的旧 running/queued job（进程可能已重启）：标记 failed，重建新的
    await prisma.ad_generation_jobs
      .update({ where: { id: existing.id }, data: { status: "failed", error: "任务僵死，已重建" } })
      .catch(() => {});
  }

  // 2026-07-13（第七轮）P0：同泳道但参数不同的活跃 job（改关键词/语言/重新爬取后再点生成）
  // 一律标 failed 让位——否则两条完整流水线并行双跑、互相覆盖结果。
  const laneRivals = actives.filter((j) => j.id !== existing?.id && safeLane(j) === laneSig);
  for (const rival of laneRivals) {
    await prisma.ad_generation_jobs
      .update({ where: { id: rival.id }, data: { status: "failed", error: "生成参数已变更，任务被新请求取代" } })
      .catch(() => {});
    console.warn(`[GenRunner] 同泳道旧 job=${rival.id} 已让位（参数变更）`);
  }

  const job = await prisma.ad_generation_jobs.create({
    data: {
      campaign_id: campaignId,
      user_id: userId,
      // 注：types 列实际存放完整生成请求载荷（types + ad_language + keywords + optionalTypes），供 runner 回放
      types: payload as unknown as object,
      status: "queued",
      stage: "queued",
      progress: 0,
      heartbeat_at: new Date(),
    },
  });
  return { id: job.id, reused: false };
}

/**
 * 把 job 投入后台执行（非阻塞）。同一进程内对同一 job 幂等：已在跑则直接 no-op。
 * 适用于：generate-start 新建后入队，以及启动恢复重新入队。
 */
export function enqueueGenerationJob(jobId: bigint): void {
  const key = jobId.toString();
  if (inFlight.has(key)) return;
  inFlight.add(key);
  // 不 await：后台跑，调用方（POST）立即返回 job_id
  void runGenerationJobById(jobId).finally(() => inFlight.delete(key));
}

/**
 * 后台执行一个 job：装配上下文 → 构造与 SSE 旧链路一致的流水线 → 消费流并落库。
 */
export async function runGenerationJobById(jobId: bigint): Promise<void> {
  const job = await prisma.ad_generation_jobs.findUnique({ where: { id: jobId } });
  if (!job) return;
  if (job.status === "done" || job.status === "failed") return;

  const payload = (job.types ?? {}) as unknown as GenerationRequestPayload;

  // 2026-07-13（第七轮）P0：CAS 认领——只允许「queued → running」或「僵死 running 再认领」。
  // 旧逻辑无条件置 running：启动恢复 + cron 扫队 + 正常入队三方可对同一 job 并发置 running
  // 双跑整条流水线（爬虫+AI 全双份）。心跳新鲜的 running job 一律不抢。
  const staleBefore = new Date(Date.now() - STALE_MS);
  const claimed = await prisma.ad_generation_jobs.updateMany({
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
    console.warn(`[GenRunner] job=${jobId} 已被其他进程认领（心跳新鲜），本次跳过`);
    return;
  }

  try {
    // 动态导入，避免与 route 模块形成静态循环依赖
    const mod = await import("@/app/api/user/ad-creation/generate-extensions/route");
    const loaded = await mod.loadGenContext(job.campaign_id, job.user_id, payload);
    if ("error" in loaded) {
      await finalizeFailed(jobId, loaded.error);
      return;
    }
    const stream = mod.buildGenerationStream(loaded.ctx);
    await consumeStreamIntoJob(jobId, stream);
  } catch (e) {
    console.error(`[GenRunner] job=${jobId} 执行异常:`, e instanceof Error ? e.message : e);
    await finalizeFailed(jobId, e instanceof Error ? e.message : String(e));
  }
}

/**
 * 消费一条 SSE ReadableStream，把每个事件解析后去抖落库到 ad_generation_jobs.result。
 * 不回传给任何客户端；连接概念在这里彻底消失——流跑完即落库。
 */
async function consumeStreamIntoJob(jobId: bigint, stream: ReadableStream): Promise<void> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  const events: Record<string, unknown> = {};
  let seq = 0;
  let stage: string | null = "queued";
  let progress = 0;
  let sawError: string | null = null;

  // 去抖落库
  let lastFlush = 0;
  let flushTimer: ReturnType<typeof setTimeout> | null = null;
  let dirty = false;

  const doFlush = async () => {
    if (!dirty) return;
    dirty = false;
    // D-160：用 updateMany + status 条件，不复活已被外部判僵死标 failed 的 job
    // （旧逻辑无条件写 status:"running"，会把 failed 改回 running，与重建的新 job 双跑）
    await prisma.ad_generation_jobs
      .updateMany({
        where: { id: jobId, status: { in: ["queued", "running"] } },
        data: {
          result: { events, seq } as unknown as object,
          stage: stage ?? undefined,
          progress: clampProgress(progress),
          status: "running",
          heartbeat_at: new Date(),
        },
      })
      .catch((e) => console.warn(`[GenRunner] job=${jobId} flush 失败:`, e instanceof Error ? e.message : e));
    lastFlush = Date.now();
  };

  // D-160 周期心跳：爬虫/巡航阶段可 60-165s 无 SSE 事件，旧逻辑只在事件落库时写心跳，
  // 健康 job 会被 generate-start / sweeper 误判僵死。每 30s 主动续心跳（不碰 result）。
  const hbTimer = setInterval(() => {
    void prisma.ad_generation_jobs
      .updateMany({
        where: { id: jobId, status: { in: ["queued", "running"] } },
        data: { heartbeat_at: new Date() },
      })
      .catch(() => {});
  }, 30_000);
  hbTimer.unref?.();

  const scheduleFlush = () => {
    dirty = true;
    if (flushTimer) return;
    const wait = Math.max(0, FLUSH_MS - (Date.now() - lastFlush));
    flushTimer = setTimeout(() => {
      flushTimer = null;
      void doFlush();
    }, wait);
    flushTimer.unref?.();
  };

  const applyEvent = (type: string, data: unknown) => {
    events[type] = data;
    seq += 1;
    const mapped = STAGE_MAP[type];
    if (mapped) {
      stage = mapped.stage;
      if (mapped.progress > progress) progress = mapped.progress;
    }
    if (type === "error") {
      sawError = typeof data === "string" ? data : JSON.stringify(data);
    }
    scheduleFlush();
  };

  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let idx: number;
      // SSE 事件以空行(\n\n)分隔
      while ((idx = buffer.indexOf("\n\n")) !== -1) {
        const rawEvent = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 2);
        for (const line of rawEvent.split("\n")) {
          if (!line.startsWith("data:")) continue; // 忽略 ": keepalive" 等注释行
          const payloadStr = line.slice(5).trim();
          if (!payloadStr || payloadStr === "[DONE]") continue;
          try {
            const obj = JSON.parse(payloadStr) as { type?: string; data?: unknown };
            if (obj && typeof obj.type === "string") applyEvent(obj.type, obj.data);
          } catch {
            /* 容错：忽略无法解析的行 */
          }
        }
      }
    }
  } catch (e) {
    sawError = sawError || (e instanceof Error ? e.message : String(e));
  } finally {
    clearInterval(hbTimer);
    if (flushTimer) {
      clearTimeout(flushTimer);
      flushTimer = null;
    }
    try {
      reader.releaseLock();
    } catch {
      /* noop */
    }
  }

  // 终态：有 error 事件且无任何实质产出 → failed；否则 done（已 persist 的部分结果保留）
  const hasContent = CONTENT_EVENT_KEYS.some((k) => k in events);
  const finalStatus = sawError && !hasContent ? "failed" : "done";

  // 2026-07-13（第七轮）P0：终态写入 CAS 化——仅当 job 仍处 queued/running 时写终态。
  // 旧逻辑无条件 update：job 若已被 generate-start 判僵死标 failed 并重建，僵尸流跑完
  // 会把 failed 覆盖回 done，与重建的新 job 互相踩踏（前端看到结果反复横跳）。
  const finalized = await prisma.ad_generation_jobs
    .updateMany({
      where: { id: jobId, status: { in: ["queued", "running"] } },
      data: {
        result: { events, seq } as unknown as object,
        stage: finalStatus === "done" ? "done" : stage ?? undefined,
        progress: finalStatus === "done" ? 100 : clampProgress(progress),
        status: finalStatus,
        error: finalStatus === "failed" ? (sawError ?? "生成失败，请重试").slice(0, 1000) : null,
        heartbeat_at: new Date(),
      },
    })
    .catch((e) => {
      console.warn(`[GenRunner] job=${jobId} 终态写入失败:`, e instanceof Error ? e.message : e);
      return { count: -1 };
    });
  if (finalized && finalized.count === 0) {
    console.warn(`[GenRunner] job=${jobId} 终态未写入（已被外部标记 failed/done，本流为僵尸流）`);
  }

  console.warn(`[GenRunner] job=${jobId} 完成 status=${finalStatus} seq=${seq} hasContent=${hasContent}`);
}

async function finalizeFailed(jobId: bigint, message: string): Promise<void> {
  // CAS：已 done 的 job 不允许再被标 failed（如恢复路径与正常完成竞态）
  await prisma.ad_generation_jobs
    .updateMany({
      where: { id: jobId, status: { in: ["queued", "running"] } },
      data: { status: "failed", error: (message || "生成失败").slice(0, 1000), heartbeat_at: new Date() },
    })
    .catch(() => {});
}

function clampProgress(p: number): number {
  if (p < 0) return 0;
  if (p > 99) return 99;
  return Math.round(p);
}

/**
 * 启动恢复：把卡在 running/queued 的 job 重新入队。
 * 部署重启后，进程内队列丢失，但 job 行仍在；爬取/画像缓存(7 天)命中 → 重跑快且省。
 * 尝试次数超限的直接判失败，避免无限重跑。模块首次加载时自动执行一次。
 */
let recoveryRan = false;
export async function recoverInterruptedJobs(): Promise<void> {
  if (recoveryRan) return;
  recoveryRan = true;
  try {
    const stuck = await prisma.ad_generation_jobs.findMany({
      where: { status: { in: ["running", "queued"] } },
      orderBy: { id: "asc" },
      take: 20,
    });
    if (stuck.length === 0) return;
    console.warn(`[GenRunner] 启动恢复：发现 ${stuck.length} 个未完成 job`);
    for (const job of stuck) {
      if ((job.attempt ?? 0) >= MAX_ATTEMPT) {
        await finalizeFailed(job.id, "服务重启后多次重试仍失败，请重新生成");
        continue;
      }
      console.warn(`[GenRunner] 重新入队 job=${job.id} campaign=${job.campaign_id} attempt=${job.attempt}`);
      enqueueGenerationJob(job.id);
    }
  } catch (e) {
    console.warn("[GenRunner] 启动恢复失败:", e instanceof Error ? e.message : e);
  }
}

/**
 * DB 驱动扫队（由 /api/cron/job-sweeper 周期调用）：
 * 把「queued 未被捡起」和「running 但心跳超时（进程崩溃/重启丢失）」的生成 job 重新入队；
 * 超尝试次数上限的判失败。同进程 inFlight 去重保证重复 enqueue 为 no-op。
 */
export async function sweepGenerationJobs(): Promise<{ scanned: number; requeued: number; failed: number }> {
  const stats = { scanned: 0, requeued: 0, failed: 0 };
  const candidates = await prisma.ad_generation_jobs.findMany({
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
      await finalizeFailed(job.id, "任务多次中断后仍未完成，请重新生成");
      stats.failed++;
      continue;
    }
    console.warn(`[GenRunner] sweeper 重新入队 job=${job.id} status=${job.status} attempt=${job.attempt}`);
    enqueueGenerationJob(job.id);
    stats.requeued++;
  }
  return stats;
}

// 模块首次加载即触发一次启动恢复（延迟一点，确保 DB 连接就绪）
setTimeout(() => {
  void recoverInterruptedJobs();
}, 5_000).unref?.();
