import prisma from "@/lib/prisma";
import { backfillAndRepairPublishedArticles, repairArticleIfNeeded } from "@/lib/article-backfill";

export interface AutoRepairResult {
  scanned: number;
  repaired: number;
  skipped: number;
  failed: number;
  errors: string[];
}

interface RepairOptions {
  userId?: bigint;
  articleIds?: bigint[];
  limit?: number;
  requirePublishedOnly?: boolean;
  includeBackfill?: boolean;
}

const repairLocks = new Set<string>();
const repairLastRunAt = new Map<string, number>();
const REPAIR_COOLDOWN_MS = 10 * 60 * 1000;

function getScopeKey(options: RepairOptions) {
  return [
    options.userId ? `user:${options.userId}` : "all-users",
    options.articleIds?.length ? `ids:${options.articleIds.map(String).join(",")}` : "all-articles",
    `published:${options.requirePublishedOnly === false ? 0 : 1}`,
    `backfill:${options.includeBackfill === false ? 0 : 1}`,
  ].join("|");
}

export async function autoRepairPublishedArticles(options: RepairOptions = {}): Promise<AutoRepairResult> {
  const scopeKey = getScopeKey(options);
  const lastRunAt = repairLastRunAt.get(scopeKey) || 0;
  if (Date.now() - lastRunAt < REPAIR_COOLDOWN_MS) {
    return { scanned: 0, repaired: 0, skipped: 0, failed: 0, errors: [] };
  }

  if (repairLocks.has(scopeKey)) {
    return { scanned: 0, repaired: 0, skipped: 0, failed: 0, errors: [] };
  }
  repairLocks.add(scopeKey);

  try {
    const limit = Math.min(Math.max(options.limit ?? 10, 1), 50);
    const where: Record<string, unknown> = {
      is_deleted: 0,
      publish_site_id: { not: null },
      ...(options.requirePublishedOnly === false ? {} : { status: "published" }),
    };

    if (options.userId) where.user_id = options.userId;
    if (options.articleIds?.length) {
      where.id = { in: options.articleIds };
    }

    const articles = await prisma.articles.findMany({
      where: where as never,
      orderBy: { id: "asc" },
      take: limit,
      select: { id: true },
    });

    const result: AutoRepairResult = {
      scanned: articles.length,
      repaired: 0,
      skipped: 0,
      failed: 0,
      errors: [],
    };

    if (options.includeBackfill !== false) {
      const backfillRes = await backfillAndRepairPublishedArticles({
        userId: options.userId,
        limitSites: Math.min(limit, 20),
        limitEntriesPerSite: 200,
      });
      result.repaired += backfillRes.repaired;
      result.skipped += backfillRes.skipped;
      result.failed += backfillRes.failed;
      result.errors.push(...backfillRes.errors);
    }

    for (const article of articles) {
      const repairRes = await repairArticleIfNeeded(article.id);
      if (repairRes.repaired) {
        result.repaired++;
      } else if (repairRes.failed) {
        result.failed++;
        if (repairRes.error) result.errors.push(`#${article.id}: ${repairRes.error}`);
      } else {
        result.skipped++;
      }
    }

    repairLastRunAt.set(scopeKey, Date.now());
    return result;
  } finally {
    repairLocks.delete(scopeKey);
  }
}
