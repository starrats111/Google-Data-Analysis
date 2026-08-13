/**
 * Pure aggregation helpers for the ad-create failure diagnostic script.
 *
 * The functions accept plain row objects so they can be unit-tested without
 * requiring Prisma or a live database. The CLI entry point at
 * `scripts/diagnose-ad-create-failures.ts` wires these helpers to Prisma
 * read-only queries.
 */

const MAX_PATTERN_LENGTH = 200;

const URL_PATTERN = /https?:\/\/\S+/gi;
const QUOTED_PATTERN = /"[^"]+"|'[^']+'/g;
const NUMBER_PATTERN = /\b\d{2,}\b/g;
const WHITESPACE_PATTERN = /\s+/g;

export type PendingBatchItemRow = {
  id: string;
  batch_job_id: string;
  generation_status: string;
  publish_status: string;
  created_at: Date;
};

export type DraftFailureRow = {
  failed_stage: string | null;
  generation_mode: string | null;
  error_message: string | null;
};

export type PublishFailureRow = {
  failed_stage: string | null;
  retryable: boolean | null;
  selected_cid: string | null;
  error_message: string | null;
};

export interface PendingBatchItemSummary {
  total: number;
  byBatchJob: Array<{ batchJobId: string; count: number }>;
  oldestAgeDays: number;
}

export interface DraftFailureSummary {
  total: number;
  byStage: Array<{ failedStage: string; count: number }>;
  byMode: Array<{ generationMode: string; count: number }>;
  errorsByStage: Array<{
    failedStage: string;
    errors: Array<{ pattern: string; count: number }>;
  }>;
}

export interface PublishFailureSummary {
  total: number;
  byStage: Array<{ failedStage: string; count: number }>;
  byRetryable: Array<{ retryable: boolean; count: number }>;
  byCid: Array<{ selectedCid: string; count: number }>;
  errorsByStage: Array<{
    failedStage: string;
    errors: Array<{ pattern: string; count: number }>;
  }>;
}

export interface FailureRecommendationInput {
  pending: PendingBatchItemSummary;
  drafts: DraftFailureSummary;
  publish: PublishFailureSummary;
}

export interface FailureRecommendations {
  suggestions: string[];
}

export function normalizeErrorPattern(input: string | null | undefined): string {
  if (!input) return "(empty)";
  let text = String(input).trim();
  if (!text) return "(empty)";

  text = text.replace(URL_PATTERN, "<url>");
  text = text.replace(QUOTED_PATTERN, "<quoted>");
  text = text.replace(NUMBER_PATTERN, "<n>");
  text = text.replace(WHITESPACE_PATTERN, " ").trim();

  if (text.length > MAX_PATTERN_LENGTH) {
    text = `${text.slice(0, MAX_PATTERN_LENGTH - 1)}…`;
  }
  return text;
}

function topByCount<T extends { count: number }>(rows: T[], limit?: number): T[] {
  const sorted = [...rows].sort((a, b) => b.count - a.count);
  return typeof limit === "number" ? sorted.slice(0, limit) : sorted;
}

function diffDays(from: Date, to: Date): number {
  const ms = to.getTime() - from.getTime();
  if (!Number.isFinite(ms) || ms <= 0) return 0;
  return Math.floor(ms / (24 * 60 * 60 * 1000));
}

export function summarizePendingBatchItems(
  rows: PendingBatchItemRow[],
  now: Date = new Date(),
): PendingBatchItemSummary {
  const total = rows.length;
  const grouped = new Map<string, number>();
  let oldest: Date | null = null;
  for (const row of rows) {
    grouped.set(row.batch_job_id, (grouped.get(row.batch_job_id) ?? 0) + 1);
    if (!oldest || row.created_at.getTime() < oldest.getTime()) {
      oldest = row.created_at;
    }
  }
  const byBatchJob = topByCount(
    [...grouped.entries()].map(([batchJobId, count]) => ({ batchJobId, count })),
  );
  return {
    total,
    byBatchJob,
    oldestAgeDays: oldest ? diffDays(oldest, now) : 0,
  };
}

interface AggregateOptions {
  topPerStage?: number;
}

function bucketCounts<K extends string | number | boolean | null>(
  rows: Array<{ key: K; weight?: number }>,
  fallback: K,
): Array<{ key: NonNullable<K>; count: number }> {
  const map = new Map<NonNullable<K>, number>();
  for (const row of rows) {
    const key = (row.key ?? fallback) as NonNullable<K>;
    map.set(key, (map.get(key) ?? 0) + (row.weight ?? 1));
  }
  return [...map.entries()]
    .map(([key, count]) => ({ key, count }))
    .sort((a, b) => b.count - a.count);
}

export function summarizeDraftFailures(
  rows: DraftFailureRow[],
  options: AggregateOptions = {},
): DraftFailureSummary {
  const total = rows.length;

  const byStage = bucketCounts(
    rows.map((row) => ({ key: row.failed_stage ?? "(unknown)" })),
    "(unknown)",
  ).map(({ key, count }) => ({ failedStage: String(key), count }));

  const byMode = bucketCounts(
    rows.map((row) => ({ key: row.generation_mode ?? "(unknown)" })),
    "(unknown)",
  ).map(({ key, count }) => ({ generationMode: String(key), count }));

  const stageBuckets = new Map<string, Map<string, number>>();
  for (const row of rows) {
    const stage = row.failed_stage ?? "(unknown)";
    const pattern = normalizeErrorPattern(row.error_message);
    if (!stageBuckets.has(stage)) stageBuckets.set(stage, new Map());
    const inner = stageBuckets.get(stage)!;
    inner.set(pattern, (inner.get(pattern) ?? 0) + 1);
  }

  const errorsByStage = byStage.map(({ failedStage }) => {
    const errors = topByCount(
      [...(stageBuckets.get(failedStage) ?? new Map()).entries()].map(([pattern, count]) => ({
        pattern,
        count,
      })),
      options.topPerStage,
    );
    return { failedStage, errors };
  });

  return { total, byStage, byMode, errorsByStage };
}

export function summarizePublishFailures(
  rows: PublishFailureRow[],
  options: AggregateOptions = {},
): PublishFailureSummary {
  const total = rows.length;

  const byStage = bucketCounts(
    rows.map((row) => ({ key: row.failed_stage ?? "(unknown)" })),
    "(unknown)",
  ).map(({ key, count }) => ({ failedStage: String(key), count }));

  const byRetryable = bucketCounts(
    rows.map((row) => ({ key: row.retryable ?? false })),
    false,
  ).map(({ key, count }) => ({ retryable: Boolean(key), count }));

  const byCid = bucketCounts(
    rows.map((row) => ({ key: row.selected_cid ?? "(none)" })),
    "(none)",
  ).map(({ key, count }) => ({ selectedCid: String(key), count }));

  const stageBuckets = new Map<string, Map<string, number>>();
  for (const row of rows) {
    const stage = row.failed_stage ?? "(unknown)";
    const pattern = normalizeErrorPattern(row.error_message);
    if (!stageBuckets.has(stage)) stageBuckets.set(stage, new Map());
    const inner = stageBuckets.get(stage)!;
    inner.set(pattern, (inner.get(pattern) ?? 0) + 1);
  }

  const errorsByStage = byStage.map(({ failedStage }) => {
    const errors = topByCount(
      [...(stageBuckets.get(failedStage) ?? new Map()).entries()].map(([pattern, count]) => ({
        pattern,
        count,
      })),
      options.topPerStage,
    );
    return { failedStage, errors };
  });

  return { total, byStage, byRetryable, byCid, errorsByStage };
}

const POLICY_KEYWORDS = ["policy", "violat", "disapprov", "permission", "auth", "credential"];

function looksLikePolicy(pattern: string): boolean {
  const lower = pattern.toLowerCase();
  return POLICY_KEYWORDS.some((keyword) => lower.includes(keyword));
}

export function buildFailureRecommendations(
  input: FailureRecommendationInput,
): FailureRecommendations {
  const suggestions: string[] = [];

  if (input.pending.total > 0) {
    suggestions.push(
      `${input.pending.total} batch items are stuck pending (oldest ~${input.pending.oldestAgeDays}d). ` +
        "There is no server-side batch executor advancing them; either backfill via batch executor cron or drop the rows after migration.",
    );
  }

  if (input.publish.total > 0) {
    const retryable = input.publish.byRetryable.find((entry) => entry.retryable === true)?.count ?? 0;
    const nonRetryable =
      input.publish.byRetryable.find((entry) => entry.retryable === false)?.count ?? 0;
    const total = retryable + nonRetryable;
    const dominantPolicy = input.publish.errorsByStage
      .flatMap((stage) => stage.errors)
      .some((entry) => looksLikePolicy(entry.pattern) && entry.count >= Math.max(1, Math.ceil(total / 2)));

    if (total > 0 && retryable / total > 0.5 && !dominantPolicy) {
      suggestions.push(
        `publish failures look safe to retry (${retryable}/${total} retryable). Consider a bounded re-run via the publish runner.`,
      );
    } else {
      suggestions.push(
        "publish failures need manual review before retry: many are non-retryable or look like policy/credential issues.",
      );
    }
  }

  if (input.drafts.total > 0) {
    const fetchStage = input.drafts.byStage.find((entry) => entry.failedStage === "fetch_rival_ads");
    if (fetchStage && fetchStage.count >= Math.max(10, Math.ceil(input.drafts.total / 2))) {
      suggestions.push(
        `most draft failures concentrate at fetch_rival_ads (${fetchStage.count}/${input.drafts.total}). ` +
          "Inspect 3UE upstream rate limits / domain coverage before retrying drafts.",
      );
    }
  }

  return { suggestions };
}
