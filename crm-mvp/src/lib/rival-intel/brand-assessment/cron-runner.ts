/**
 * Cron runner: 从 `brand_assessment_jobs` 表 claim 一批 pending job 并执行。
 *
 * 每次 cron tick：
 *   1) 循环最多 `maxJobs` 次：claimPendingJob → 遍历 countries → engine.run
 *   2) 累计实际成本、合并 engine_status、写回 job.finished_at/status
 *
 * 整体状态收敛：
 *   - 所有国家 status=ok → job "ok"
 *   - 存在 cost_aborted → job "cost_aborted"
 *   - 存在 partial / failed → job "partial" 或 "failed"（按严重度取优先）
 *
 * 注意：DB 并发抢占由 `claimPendingJob` 的 CAS 保证，这里可以安全串行处理。
 */

import { prisma } from "@/lib/prisma";
import { getPoolKeys } from "@/lib/serpapi-key-pool";
import { runBrandAssessmentJob, type EngineDeps, type EngineRepo } from "./engine";
import * as repo from "./repository";
import type { BrandAssessmentEngineOutput } from "./types";

export interface CronRunSummary {
  picked: number;
  processed: number;
  ok: number;
  partial: number;
  failed: number;
  cost_aborted: number;
  totalSerpapiCostUsd: number;
  totalLlmCostUsd: number;
  processedJobIds: string[];
}

export interface CronRunnerDeps
  extends Omit<EngineDeps, "repo"> {
  /**
   * 每次 cron tick 最多处理的 job 数（防止超时 / 单 tick 预算溢出）。
   */
  maxJobs?: number;
}

export async function runCronTick(
  deps: CronRunnerDeps,
): Promise<CronRunSummary> {
  const summary: CronRunSummary = {
    picked: 0,
    processed: 0,
    ok: 0,
    partial: 0,
    failed: 0,
    cost_aborted: 0,
    totalSerpapiCostUsd: 0,
    totalLlmCostUsd: 0,
    processedJobIds: [],
  };

  const maxJobs = deps.maxJobs ?? 5;
  const engineRepo: EngineRepo = {
    readEngineConfig: async () => {
      const [keys, dailyBudgetUsd] = await Promise.all([
        getPoolKeys(),
        repo.readDailyBudgetUsd(),
      ]);
      return {
        serpapiKey: keys[0] ?? null,
        brandAssessmentPrompt: await repo.readBrandAssessmentPrompt(),
        dailyBudgetUsd,
      };
    },
    getCachedResult: (p) => repo.getCachedResult(p),
    upsertResult: (input) => repo.upsertResult(input),
    addCostLedger: (p) => repo.addCostLedger({ ...p, provider: "serpapi" }),
    getTodayTotalUsd: (p) => repo.getTodayTotalUsd(p),
  };

  for (let i = 0; i < maxJobs; i++) {
    const now = deps.now ? deps.now() : new Date();
    const claim = await repo.claimPendingJob(now);
    if (!claim) break;
    summary.picked += 1;

    const job = await repo.getJobById(claim.id);
    if (!job) continue;

    const countries = Array.isArray(job.countries)
      ? (job.countries as unknown[]).filter(
          (c): c is string => typeof c === "string",
        )
      : [];

    const perCountry: BrandAssessmentEngineOutput[] = [];
    let costAborted = 0;
    let anyFailed = 0;
    let anyPartial = 0;
    let anyOk = 0;
    let totalSerp = 0;
    let totalLlm = 0;
    let lastErrorMessage: string | undefined;

    for (const country of countries) {
      try {
        const out = await runBrandAssessmentJob(
          {
            userId: job.user_id,
            jobId: job.id,
            domain: job.domain,
            country,
            forceRefresh: job.force_refresh === 1,
          },
          { ...deps, repo: engineRepo },
        );
        perCountry.push(out);
        totalSerp += out.serpapiCostUsd;
        totalLlm += out.llmCostUsd;
        if (out.status === "ok") anyOk += 1;
        else if (out.status === "partial") anyPartial += 1;
        else if (out.status === "cost_aborted") costAborted += 1;
        else anyFailed += 1;
        if (out.errorMessage) lastErrorMessage = out.errorMessage;
      } catch (e) {
        anyFailed += 1;
        lastErrorMessage =
          e instanceof Error ? e.message : String(e);
      }
    }

    let finalStatus: "ok" | "partial" | "failed" | "cost_aborted";
    if (anyOk + anyPartial + anyFailed + costAborted === 0) {
      finalStatus = "failed";
    } else if (costAborted > 0 && anyOk === 0) {
      finalStatus = "cost_aborted";
    } else if (anyFailed === countries.length) {
      finalStatus = "failed";
    } else if (anyFailed > 0 || anyPartial > 0 || costAborted > 0) {
      finalStatus = "partial";
    } else {
      finalStatus = "ok";
    }

    try {
      await repo.markJobFinished(claim.id, {
        status: finalStatus,
        errorMessage: lastErrorMessage,
        actualCostUsd: totalSerp + totalLlm,
        finishedAt: new Date(),
      });
    } catch {
      // ignore: best-effort
    }

    summary.processed += 1;
    summary.processedJobIds.push(String(claim.id));
    summary.totalSerpapiCostUsd += totalSerp;
    summary.totalLlmCostUsd += totalLlm;
    if (finalStatus === "ok") summary.ok += 1;
    else if (finalStatus === "partial") summary.partial += 1;
    else if (finalStatus === "cost_aborted") summary.cost_aborted += 1;
    else summary.failed += 1;
  }

  return summary;
}

// re-exporter so callers can `import { prisma } from`... without circular deps
export { prisma as _prisma };
