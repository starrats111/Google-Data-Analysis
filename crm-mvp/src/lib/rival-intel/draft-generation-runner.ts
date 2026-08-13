/**
 * 竞品情报引擎 — 草稿生成的后台 runner。
 *
 * D-233 的一处实质改造，不是简单移植：
 *
 * kyads 那边没有 worker。它的 `GET /api/ad-create/drafts/:id` 每被调用一次就推进
 * **一个** 阶段，靠前端每 2 秒轮询这个 GET 把五个阶段一路点完，并用一个进程内
 * `Set` 当锁。后果是员工一关页面、一切标签页、网断一下，草稿就永久卡在中间阶段，
 * 而 SerpApi / LLM 的钱已经花掉了。
 *
 * CRM 这边对齐 evidence 引擎的做法（generation-runner.ts）：进程内后台跑到底 +
 * DB 抢锁 + cron 扫僵尸。关键差别：
 *   - 一次认领跑完**全部剩余阶段**，不再一次一个（没有前端来点第二下）
 *   - 锁落库（`stage_running` / `stage_claimed_at`），跨进程有效，重启不会双跑
 *   - 每 30s 续一次 `stage_claimed_at` 当心跳，进程崩了 STALE_MS 后别人能接管
 */
import prisma from "@/lib/prisma";
import {
  advanceDraftOnce,
  markDraftStageCompleted,
  markDraftStageFailed,
  markDraftStageSkipped,
  type CompletedStageEntry,
  type DraftState,
} from "./ad-create/draft-runner";
import { getDraftById, updateDraft } from "./ad-create/repository";
import type { DraftStage } from "./ad-create/types";
import { executeDraftStage } from "./stages/execute-draft-stage";

/** 心跳超过这么久没续，视作持锁进程已死，允许别人接管 */
const STALE_MS = 300_000;
const HEARTBEAT_MS = 30_000;

/** 同一进程内同一草稿只跑一份 */
const inFlight = new Set<string>();

/**
 * 投入后台执行（非阻塞）。调用方（创建草稿的 API）立即返回 draftId，
 * 前端只需要轮询草稿状态读进度，不再驱动流程。
 */
export function enqueueDraftGeneration(draftId: bigint): void {
  const key = draftId.toString();
  if (inFlight.has(key)) return;
  inFlight.add(key);
  void runDraftGeneration(draftId).finally(() => inFlight.delete(key));
}

/**
 * 认领并把一份草稿从当前阶段推到终态。
 *
 * 抢锁用 `updateMany` 的条件更新（编译成单条 `UPDATE ... WHERE`），MariaDB 的行锁
 * 保证并发下只有一个调用拿到 count=1。
 */
export async function runDraftGeneration(draftId: bigint): Promise<void> {
  const staleBefore = new Date(Date.now() - STALE_MS);
  const claimed = await prisma.ad_creation_drafts
    .updateMany({
      where: {
        id: draftId,
        status: "draft_generating",
        is_deleted: 0,
        failed_stage: null,
        OR: [
          { stage_running: 0 },
          { stage_claimed_at: null },
          { stage_claimed_at: { lt: staleBefore } },
        ],
      },
      data: { stage_running: 1, stage_claimed_at: new Date() },
    })
    .catch(() => ({ count: 0 }));

  if (claimed.count === 0) return;

  const heartbeat = setInterval(() => {
    void prisma.ad_creation_drafts
      .updateMany({
        where: { id: draftId, stage_running: 1 },
        data: { stage_claimed_at: new Date() },
      })
      .catch(() => {});
  }, HEARTBEAT_MS);
  heartbeat.unref?.();

  try {
    // 上限 = 阶段数 + 2，纯粹是防御性的：advanceDraftOnce 每轮必然吃掉一个未完成阶段，
    // 正常情况下循环会因为 currentStage 变 null 而退出。
    for (let guard = 0; guard < 8; guard += 1) {
      const draft = await getDraftById(draftId);
      if (!draft) return;
      if (draft.status !== "draft_generating" || draft.failed_stage) return;

      const completedStages = (draft.completed_stages as CompletedStageEntry[] | null) ?? [];
      const state: DraftState = advanceDraftOnce({
        status: draft.status,
        currentStage: draft.current_stage,
        completedStages,
        failedStage: draft.failed_stage,
      });

      if (!state.currentStage) {
        if (state.status !== draft.status) {
          await updateDraft(draftId, {
            status: state.status,
            current_stage: state.currentStage,
          });
        }
        return;
      }

      const stage = state.currentStage as DraftStage;
      await updateDraft(draftId, { current_stage: stage });

      try {
        const result = await executeDraftStage(draftId, stage, draft);
        const advanced = result?.skipped
          ? markDraftStageSkipped(state, stage)
          : markDraftStageCompleted(state, stage);
        await updateDraft(draftId, {
          status: advanced.status,
          current_stage: advanced.currentStage,
          completed_stages: advanced.completedStages,
        });
        if (advanced.status !== "draft_generating") return;
      } catch (err) {
        const errorMsg = err instanceof Error ? err.message : String(err);
        const failed = markDraftStageFailed(state, stage, errorMsg);
        await updateDraft(draftId, {
          status: failed.status,
          current_stage: failed.currentStage,
          failed_stage: failed.failedStage,
          error_message: errorMsg.slice(0, 1000),
          retryable: 1,
        });
        console.error(`[RivalIntel] draft=${draftId} 阶段 ${stage} 失败: ${errorMsg}`);
        return;
      }
    }
    console.warn(`[RivalIntel] draft=${draftId} 推进次数超上限，本次退出等下轮扫队`);
  } finally {
    clearInterval(heartbeat);
    await prisma.ad_creation_drafts
      .updateMany({
        where: { id: draftId },
        data: { stage_running: 0, stage_claimed_at: null },
      })
      .catch(() => {});
  }
}

/**
 * DB 驱动扫队，由 cron 周期调用。捡两类草稿：
 *   - 压根没被认领过的（创建成功但入队时进程已重启）
 *   - 持锁进程死了、心跳过期的
 */
export async function sweepDraftGeneration(): Promise<{
  scanned: number;
  requeued: number;
}> {
  const staleBefore = new Date(Date.now() - STALE_MS);
  const candidates = await prisma.ad_creation_drafts.findMany({
    where: {
      status: "draft_generating",
      is_deleted: 0,
      failed_stage: null,
      OR: [
        { stage_running: 0 },
        { stage_claimed_at: null },
        { stage_claimed_at: { lt: staleBefore } },
      ],
    },
    orderBy: { id: "asc" },
    take: 20,
    select: { id: true },
  });

  let requeued = 0;
  for (const row of candidates) {
    if (inFlight.has(row.id.toString())) continue;
    enqueueDraftGeneration(row.id);
    requeued += 1;
  }
  return { scanned: candidates.length, requeued };
}
