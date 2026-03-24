import { NextRequest } from "next/server";
import { getUserFromRequest } from "@/lib/auth";
import { apiSuccess, apiError } from "@/lib/constants";
import prisma from "@/lib/prisma";
import { publishArticleToSite, verifyConnection } from "@/lib/remote-publisher";

const MAX_BATCH_SIZE = 10;

export async function POST(req: NextRequest) {
  const user = getUserFromRequest(req);
  if (!user) return apiError("未授权", 401);

  const body = await req.json();
  const {
    site_id,
    dry_run = false,
    limit = 5,
    offset = 0,
    article_ids,
  } = body;

  if (!site_id) return apiError("缺少站点 ID");

  let site = await prisma.publish_sites.findFirst({
    where: { id: BigInt(site_id), is_deleted: 0, status: "active" },
  });
  if (!site || !site.site_path || !site.domain) {
    return apiError("站点不存在或未配置", 404);
  }

  const checks = await verifyConnection(site.site_path);
  if (!checks.valid) {
    return apiError(checks.error || "站点验证失败，请先修复站点结构后再重试", 400);
  }

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

  const targetIds = Array.isArray(article_ids)
    ? article_ids
        .map((id) => {
          try {
            return BigInt(String(id));
          } catch {
            return null;
          }
        })
        .filter((id): id is bigint => id !== null)
    : [];

  const whereClause = {
    user_id: BigInt(user.userId),
    status: "published" as const,
    is_deleted: 0,
    ...(targetIds.length > 0 ? { id: { in: targetIds } } : {}),
  };

  const totalCount = await prisma.articles.count({ where: whereClause });

  const safeLimit = Math.min(Math.max(limit, 1), MAX_BATCH_SIZE);
  const safeOffset = Math.max(offset, 0);

  const articles = await prisma.articles.findMany({
    where: whereClause,
    orderBy: { id: "asc" },
    skip: targetIds.length > 0 ? 0 : safeOffset,
    take: targetIds.length > 0 ? Math.min(targetIds.length, MAX_BATCH_SIZE) : safeLimit,
  });

  if (dry_run) {
    let needContentRepair = 0;
    let alreadyLocalized = 0;
    for (const a of articles) {
      if (a.content && /(?:^|["'\/(])images\/articles\/|\/images\/articles\//.test(a.content)) {
        alreadyLocalized++;
      } else {
        needContentRepair++;
      }
    }
    return apiSuccess({
      total: totalCount,
      currentBatch: articles.length,
      needRepublish: articles.length,
      needContentRepair,
      alreadyLocalized,
      siteChecks: checks,
      offset: safeOffset,
      hasMore: targetIds.length > 0 ? false : safeOffset + safeLimit < totalCount,
    });
  }

  let repaired = 0;
  let skipped = 0;
  let failed = 0;
  const errors: string[] = [];

  for (const article of articles) {
    if (!article.content || !article.title) {
      skipped++;
      continue;
    }

    try {
      const slug = article.slug || article.title
        .toLowerCase().trim()
        .replace(/[^\w\s-]/g, "")
        .replace(/[\s_-]+/g, "-")
        .replace(/^-+|-+$/g, "");

      const result = await publishArticleToSite(
        {
          id: String(article.id),
          title: article.title,
          slug,
          content: article.content,
          category: article.category || "General",
          images: article.images,
        },
        {
          site_path: site.site_path!,
          site_type: site.site_type,
          data_js_path: site.data_js_path,
          article_var_name: site.article_var_name,
          article_html_pattern: site.article_html_pattern,
          domain: site.domain,
        }
      );

      if (result.success) {
        repaired++;
        if ((result.updatedContent && result.updatedContent !== article.content) || result.url) {
          await prisma.articles.update({
            where: { id: article.id },
            data: {
              content: result.updatedContent || article.content,
              published_url: result.url || article.published_url,
              slug,
            },
          });
        }
      } else {
        failed++;
        errors.push(`#${article.id}: ${result.error?.slice(0, 100)}`);
      }
    } catch (err) {
      failed++;
      errors.push(`#${article.id}: ${err instanceof Error ? err.message.slice(0, 100) : "unknown"}`);
    }

    await new Promise((r) => setTimeout(r, 2000));
  }

  const nextOffset = safeOffset + safeLimit;
  return apiSuccess({
    total: totalCount,
    currentBatch: articles.length,
    repaired,
    skipped,
    failed,
    offset: safeOffset,
    hasMore: targetIds.length > 0 ? false : nextOffset < totalCount,
    nextOffset: targetIds.length > 0 ? null : (nextOffset < totalCount ? nextOffset : null),
    errors: errors.length > 0 ? errors : undefined,
  });
}
