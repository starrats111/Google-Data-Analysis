import { NextRequest } from "next/server";
import { getUserFromRequest } from "@/lib/auth";
import { apiSuccess, apiError } from "@/lib/constants";
import prisma from "@/lib/prisma";
import { publishArticleToSite } from "@/lib/remote-publisher";

const MAX_BATCH_SIZE = 10;

export async function POST(req: NextRequest) {
  const user = getUserFromRequest(req);
  if (!user) return apiError("未授权", 401);

  const body = await req.json();
  const { site_id, dry_run = false, limit = 5, offset = 0 } = body;

  if (!site_id) return apiError("缺少站点 ID");

  const site = await prisma.publish_sites.findFirst({
    where: { id: BigInt(site_id), is_deleted: 0, status: "active" },
  });
  if (!site || !site.site_path || !site.domain) {
    return apiError("站点不存在或未配置", 404);
  }

  const totalCount = await prisma.articles.count({
    where: {
      user_id: BigInt(user.userId),
      status: "published",
      is_deleted: 0,
    },
  });

  const safeLimit = Math.min(Math.max(limit, 1), MAX_BATCH_SIZE);
  const safeOffset = Math.max(offset, 0);

  const articles = await prisma.articles.findMany({
    where: {
      user_id: BigInt(user.userId),
      status: "published",
      is_deleted: 0,
    },
    orderBy: { id: "asc" },
    skip: safeOffset,
    take: safeLimit,
  });

  if (dry_run) {
    let needRepair = 0;
    let alreadyRepaired = 0;
    for (const a of articles) {
      if (a.content && a.content.includes("images/articles/")) {
        alreadyRepaired++;
      } else {
        needRepair++;
      }
    }
    return apiSuccess({
      total: totalCount,
      currentBatch: articles.length,
      needRepair,
      alreadyRepaired,
      offset: safeOffset,
      hasMore: safeOffset + safeLimit < totalCount,
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

    if (article.content.includes("images/articles/")) {
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
        if (result.updatedContent && result.updatedContent !== article.content) {
          await prisma.articles.update({
            where: { id: article.id },
            data: { content: result.updatedContent },
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

    // 每篇文章间隔 2 秒，避免服务器压力
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
    hasMore: nextOffset < totalCount,
    nextOffset: nextOffset < totalCount ? nextOffset : null,
    errors: errors.length > 0 ? errors : undefined,
  });
}
