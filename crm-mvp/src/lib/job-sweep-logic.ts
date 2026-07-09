/**
 * 后台 job 的扫队/复用纯判定逻辑（submit-runner 与 generation-runner 共用，可单测）。
 * 各 runner 的 STALE_MS / MAX_ATTEMPT 不同，由调用方传入。
 */

export interface SweepableJob {
  status: string; // queued | running | done | failed
  attempt: number | null;
  heartbeat_at: Date | string | null;
  created_at: Date | string;
}

export type SweepDecision = "skip" | "requeue" | "fail";

/** job 是否仍「新鲜」（心跳或创建时间在僵死阈值内） */
export function isJobFresh(job: Pick<SweepableJob, "heartbeat_at" | "created_at">, now: number, staleMs: number): boolean {
  const hbFresh = job.heartbeat_at
    ? now - new Date(job.heartbeat_at).getTime() < staleMs
    : false;
  const justCreated = now - new Date(job.created_at).getTime() < staleMs;
  return hbFresh || justCreated;
}

/**
 * 扫队判定：
 * - 本进程正在跑（inFlight）→ skip，勿动
 * - running 且心跳新鲜 → skip（活着）
 * - queued 且新鲜且已被跑过（attempt>0）→ skip，等下一轮再判
 * - 其余（掉队的 queued / 僵死的 running）→ 超尝试上限 fail，否则 requeue
 */
export function classifyJobForSweep(
  job: SweepableJob,
  opts: { now: number; staleMs: number; maxAttempt: number; inFlight: boolean },
): SweepDecision {
  if (job.status !== "queued" && job.status !== "running") return "skip";
  if (opts.inFlight) return "skip";

  const hbAt = job.heartbeat_at
    ? new Date(job.heartbeat_at).getTime()
    : new Date(job.created_at).getTime();
  const stale = opts.now - hbAt >= opts.staleMs;

  if (job.status === "running" && !stale) return "skip";
  if (job.status === "queued" && !stale && (job.attempt ?? 0) > 0) return "skip";

  if ((job.attempt ?? 0) >= opts.maxAttempt) return "fail";
  return "requeue";
}
