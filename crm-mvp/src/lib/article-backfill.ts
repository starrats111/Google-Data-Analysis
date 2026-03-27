import prisma from "@/lib/prisma";
import { needsArticleHyperlinkRefresh } from "@/lib/sanitize";
import {
  listRemoteSiteArticles,
  publishArticleToSite,
  readRemoteSiteArticleContent,
  verifyArticlePresenceOnSite,
  verifyConnection,
} from "@/lib/remote-publisher";
import type { RemoteSiteArticleIndexEntry } from "@/lib/remote-publisher";

export interface BackfillAndRepairResult {
  scannedSites: number;
  scannedEntries: number;
  created: number;
  matchedExisting: number;
  repaired: number;
  skipped: number;
  failed: number;
  createdArticleIds: bigint[];
  errors: string[];
}

export interface BackfillOptions {
  userId?: bigint;
  siteIds?: bigint[];
  limitSites?: number;
  limitEntriesPerSite?: number;
  scanAllSitesForUser?: boolean;
}

interface CandidateMerchant {
  id: bigint;
  user_id: bigint;
  merchant_name: string;
  tracking_link: string | null;
  campaign_link: string | null;
  merchant_url: string | null;
}

interface CandidateUserScore {
  userId: bigint;
  merchantId: bigint | null;
  score: number;
}

function normalizeText(value: string | null | undefined) {
  return (value || "").toLowerCase().trim();
}

function buildSlug(title: string | null, fallback = "") {
  const source = (fallback || title || "").toLowerCase().trim();
  return source
    .replace(/[^a-z0-9\s-]/g, "")
    .replace(/[\s_-]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function extractHostname(value: string | null | undefined) {
  if (!value) return "";
  try {
    return new URL(value).hostname.replace(/^www\./, "").toLowerCase();
  } catch {
    return "";
  }
}

function parsePublishedAt(entry: RemoteSiteArticleIndexEntry) {
  const raw = entry.date || entry.dateLabel || "";
  if (!raw) return new Date();
  const direct = new Date(raw);
  return Number.isNaN(direct.getTime()) ? new Date() : direct;
}

async function ensureVerifiedSite(siteId: bigint) {
  let site = await prisma.publish_sites.findFirst({
    where: { id: siteId, is_deleted: 0, status: "active" },
  });
  if (!site || !site.site_path || !site.domain) return null;

  const checks = await verifyConnection(site.site_path);
  if (!checks.valid) return null;

  if (
    checks.site_type !== site.site_type ||
    checks.data_js_path !== site.data_js_path ||
    checks.article_var_name !== site.article_var_name ||
    checks.article_html_pattern !== site.article_html_pattern ||
    site.verified !== 1
  ) {
    site = await prisma.publish_sites.update({
      where: { id: site.id },
      data: {
        verified: 1,
        site_type: checks.site_type,
        data_js_path: checks.data_js_path,
        article_var_name: checks.article_var_name,
        article_html_pattern: checks.article_html_pattern,
      },
    });
  }

  return site;
}

async function loadCandidateUsersForSite(siteId: bigint, targetUserId?: bigint) {
  let userIds: bigint[] = [];

  if (targetUserId) {
    userIds = [targetUserId];
  } else {
    const [connections, articleUsers] = await Promise.all([
      prisma.platform_connections.findMany({
        where: { publish_site_id: siteId, is_deleted: 0 },
        select: { user_id: true },
        distinct: ["user_id"],
      }),
      prisma.articles.findMany({
        where: { publish_site_id: siteId, is_deleted: 0 },
        select: { user_id: true },
        distinct: ["user_id"],
      }),
    ]);

    userIds = [
      ...new Set([
        ...connections.map((item) => item.user_id.toString()),
        ...articleUsers.map((item) => item.user_id.toString()),
      ]),
    ].map((id) => BigInt(id));
  }

  const merchants = userIds.length > 0
    ? await prisma.user_merchants.findMany({
        where: { user_id: { in: userIds }, is_deleted: 0 },
        select: {
          id: true,
          user_id: true,
          merchant_name: true,
          tracking_link: true,
          campaign_link: true,
          merchant_url: true,
        },
      })
    : [];

  const merchantsByUser = new Map<string, CandidateMerchant[]>();
  for (const merchant of merchants) {
    const key = merchant.user_id.toString();
    if (!merchantsByUser.has(key)) merchantsByUser.set(key, []);
    merchantsByUser.get(key)!.push(merchant);
  }

  return { userIds, merchantsByUser };
}

function scoreCandidateUsers(
  entry: RemoteSiteArticleIndexEntry,
  content: string,
  userIds: bigint[],
  merchantsByUser: Map<string, CandidateMerchant[]>,
): CandidateUserScore[] {
  const haystack = normalizeText(`${entry.title} ${entry.excerpt || ""} ${content}`);
  const scores: CandidateUserScore[] = [];

  for (const userId of userIds) {
    let bestScore = 0;
    let bestMerchantId: bigint | null = null;

    for (const merchant of merchantsByUser.get(userId.toString()) || []) {
      let score = 0;
      const merchantName = normalizeText(merchant.merchant_name);
      if (merchantName && haystack.includes(merchantName)) {
        score += merchantName.length >= 8 ? 3 : 2;
      }

      for (const link of [merchant.campaign_link, merchant.tracking_link, merchant.merchant_url]) {
        const normalizedLink = normalizeText(link);
        if (normalizedLink && haystack.includes(normalizedLink)) score += 6;
        const host = extractHostname(link);
        if (host && haystack.includes(host)) score += 3;
      }

      if (score > bestScore) {
        bestScore = score;
        bestMerchantId = merchant.id;
      }
    }

    scores.push({ userId, merchantId: bestMerchantId, score: bestScore });
  }

  return scores.sort((a, b) => b.score - a.score);
}

async function resolveOwnerForEntry(siteId: bigint, entry: RemoteSiteArticleIndexEntry, content: string, targetUserId?: bigint) {
  const loaded = await loadCandidateUsersForSite(siteId, targetUserId);
  const userIds = loaded.userIds;
  const merchantsByUser = loaded.merchantsByUser;
  if (userIds.length === 0) return null;

  const scores = scoreCandidateUsers(entry, content, userIds, merchantsByUser);
  const [best, second] = scores;

  if (targetUserId) {
    if (best && best.userId === targetUserId && best.score > 0) {
      return { userId: best.userId, userMerchantId: best.merchantId };
    }

    const fallbackMerchantId = merchantsByUser.get(targetUserId.toString())?.[0]?.id || null;
    const articleCountOnSite = await prisma.articles.count({
      where: { publish_site_id: siteId, user_id: targetUserId, is_deleted: 0 },
    });

    if (articleCountOnSite > 0) {
      return { userId: targetUserId, userMerchantId: fallbackMerchantId };
    }

    return null;
  }

  if (best && best.score > 0 && (!second || best.score > second.score)) {
    return { userId: best.userId, userMerchantId: best.merchantId };
  }

  const groupedArticleUsers = await prisma.articles.groupBy({
    by: ["user_id"],
    where: { publish_site_id: siteId, is_deleted: 0 },
    _count: { _all: true },
  });
  if (groupedArticleUsers.length === 1) {
    return { userId: groupedArticleUsers[0].user_id, userMerchantId: null };
  }

  return null;
}

async function findExistingArticle(siteId: bigint, entry: RemoteSiteArticleIndexEntry, publishedUrl: string, _userId?: bigint) {
  const candidates = await prisma.articles.findMany({
    where: {
      is_deleted: 0,
      publish_site_id: siteId,
      OR: [
        { slug: entry.slug },
        { published_url: publishedUrl },
        { title: entry.title },
      ],
    },
    orderBy: { id: "asc" },
    take: 10,
  });

  const exact = candidates.find((article) => {
    if (normalizeText(article.published_url) === normalizeText(publishedUrl)) return true;
    if (normalizeText(article.slug) === normalizeText(entry.slug)) return true;
    return normalizeText(article.title) === normalizeText(entry.title);
  });

  return exact || candidates[0] || null;
}

export async function repairArticleIfNeeded(articleId: bigint) {
  const article = await prisma.articles.findFirst({
    where: { id: articleId, is_deleted: 0 },
  });
  if (!article || !article.publish_site_id || !article.title || !article.content) {
    return { repaired: false, failed: false, error: "article or site data incomplete" };
  }

  const site = await ensureVerifiedSite(article.publish_site_id);
  if (!site || !site.site_path || !site.domain) {
    return { repaired: false, failed: true, error: "site is not verified or missing config" };
  }

  const slug = article.slug || buildSlug(article.title, article.title);
  if (!slug) {
    return { repaired: false, failed: false, error: "empty slug" };
  }

  let needsRepair = needsArticleHyperlinkRefresh(article.content || "");
  if (!needsRepair) {
    const presence = await verifyArticlePresenceOnSite(
      { id: String(article.id), slug },
      {
        site_path: site.site_path,
        site_type: site.site_type,
        data_js_path: site.data_js_path,
        article_var_name: site.article_var_name,
        article_html_pattern: site.article_html_pattern,
        domain: site.domain,
      },
    );

    needsRepair = !presence.validSite
      || !presence.jsonExists
      || !presence.detailExists
      || !presence.indexedInPrimaryData
      || !presence.indexedInHomepageData;
  }

  if (!needsRepair) {
    return { repaired: false, failed: false };
  }

  const publishRes = await publishArticleToSite(
    {
      id: String(article.id),
      title: article.title,
      slug,
      content: article.content,
      category: article.category || "General",
      images: article.images,
      trackingLink: article.tracking_link,
    },
    {
      site_path: site.site_path,
      site_type: site.site_type,
      data_js_path: site.data_js_path,
      article_var_name: site.article_var_name,
      article_html_pattern: site.article_html_pattern,
      domain: site.domain,
    },
  );

  if (!publishRes.success) {
    return { repaired: false, failed: true, error: publishRes.error || "publish failed" };
  }

  await prisma.articles.update({
    where: { id: article.id },
    data: {
      slug,
      content: publishRes.updatedContent || article.content,
      publish_site_id: article.publish_site_id,
      status: "published",
      published_at: article.published_at || new Date(),
      published_url: publishRes.url || article.published_url,
    },
  });

  return { repaired: true, failed: false };
}

async function resolveSiteIds(options: BackfillOptions) {
  if (options.siteIds?.length) {
    return [...new Set(options.siteIds.map((id) => id.toString()))].map((id) => BigInt(id));
  }

  if (options.userId && options.scanAllSitesForUser) {
    return null;
  }

  if (!options.userId) return null;

  const [connections, articles] = await Promise.all([
    prisma.platform_connections.findMany({
      where: { user_id: options.userId, is_deleted: 0, publish_site_id: { not: null } },
      select: { publish_site_id: true },
    }),
    prisma.articles.findMany({
      where: { user_id: options.userId, is_deleted: 0, publish_site_id: { not: null } },
      select: { publish_site_id: true },
      distinct: ["publish_site_id"],
    }),
  ]);

  return [
    ...new Set([
      ...connections.map((item) => item.publish_site_id?.toString()).filter(Boolean) as string[],
      ...articles.map((item) => item.publish_site_id?.toString()).filter(Boolean) as string[],
    ]),
  ].map((id) => BigInt(id));
}

export async function backfillAndRepairPublishedArticles(options: BackfillOptions = {}): Promise<BackfillAndRepairResult> {
  const limitSites = Math.min(Math.max(options.limitSites ?? 20, 1), 50);
  const limitEntriesPerSite = Math.min(Math.max(options.limitEntriesPerSite ?? 300, 1), 500);
  const resolvedSiteIds = await resolveSiteIds(options);

  const sites = await prisma.publish_sites.findMany({
    where: {
      is_deleted: 0,
      status: "active",
      verified: 1,
      ...(resolvedSiteIds ? { id: { in: resolvedSiteIds } } : {}),
    },
    orderBy: { id: "asc" },
    take: limitSites,
  });

  const result: BackfillAndRepairResult = {
    scannedSites: sites.length,
    scannedEntries: 0,
    created: 0,
    matchedExisting: 0,
    repaired: 0,
    skipped: 0,
    failed: 0,
    createdArticleIds: [],
    errors: [],
  };

  for (const site of sites) {
    if (!site.site_path || !site.domain) {
      result.skipped++;
      continue;
    }

    let entries: RemoteSiteArticleIndexEntry[] = [];
    try {
      entries = await listRemoteSiteArticles({
        site_path: site.site_path,
        site_type: site.site_type,
        data_js_path: site.data_js_path,
        article_var_name: site.article_var_name,
        article_html_pattern: site.article_html_pattern,
        domain: site.domain,
      });
    } catch (err) {
      result.failed++;
      result.errors.push(`site ${site.domain}: failed to load remote index - ${err instanceof Error ? err.message : String(err)}`);
      continue;
    }

    const deduped = new Map<string, RemoteSiteArticleIndexEntry>();
    for (const entry of entries) {
      const key = `${normalizeText(entry.slug)}|${normalizeText(entry.title)}`;
      if (!deduped.has(key)) deduped.set(key, entry);
    }

    for (const entry of [...deduped.values()].slice(0, limitEntriesPerSite)) {
      result.scannedEntries++;

      try {
        const remoteContent = await readRemoteSiteArticleContent(
          entry,
          {
            site_path: site.site_path,
            site_type: site.site_type,
            data_js_path: site.data_js_path,
            article_var_name: site.article_var_name,
            article_html_pattern: site.article_html_pattern,
            domain: site.domain,
          },
        );

        if (!remoteContent.content || remoteContent.source === "excerpt" || remoteContent.source === "none") {
          result.skipped++;
          continue;
        }

        const existing = await findExistingArticle(site.id, entry, remoteContent.publishedUrl, options.userId);
        if (existing) {
          result.matchedExisting++;

          await prisma.articles.update({
            where: { id: existing.id },
            data: {
              publish_site_id: existing.publish_site_id || site.id,
              slug: existing.slug || entry.slug,
              title: existing.title || entry.title,
              content: existing.content || remoteContent.content,
              excerpt: existing.excerpt || entry.excerpt || null,
              category: existing.category || entry.category || "General",
              status: "published",
              published_at: existing.published_at || parsePublishedAt(entry),
              published_url: existing.published_url || remoteContent.publishedUrl,
            },
          });

          const repairRes = await repairArticleIfNeeded(existing.id);
          if (repairRes.repaired) {
            result.repaired++;
          } else if (repairRes.failed) {
            result.failed++;
            if (repairRes.error) result.errors.push(`article #${existing.id}: ${repairRes.error}`);
          } else {
            result.skipped++;
          }
          continue;
        }

        const owner = await resolveOwnerForEntry(site.id, entry, remoteContent.content, options.userId);
        if (!owner?.userId) {
          result.skipped++;
          result.errors.push(`site ${site.domain} / ${entry.slug}: owner mapping failed, skipped`);
          continue;
        }

        const slug = entry.slug || buildSlug(entry.title, entry.slug);
        if (!slug) {
          result.skipped++;
          continue;
        }

        const created = await prisma.articles.create({
          data: {
            user_id: owner.userId,
            user_merchant_id: owner.userMerchantId,
            publish_site_id: site.id,
            title: entry.title,
            slug,
            content: remoteContent.content,
            excerpt: entry.excerpt || null,
            language: "en",
            category: entry.category || "General",
            status: "published",
            published_at: parsePublishedAt(entry),
            published_url: remoteContent.publishedUrl,
          },
        });

        result.created++;
        result.createdArticleIds.push(created.id);

        const repairRes = await repairArticleIfNeeded(created.id);
        if (repairRes.repaired) {
          result.repaired++;
        } else if (repairRes.failed) {
          result.failed++;
          if (repairRes.error) result.errors.push(`article #${created.id}: ${repairRes.error}`);
        }
      } catch (err) {
        result.failed++;
        result.errors.push(`site ${site.domain} / ${entry.slug}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }

  return result;
}
