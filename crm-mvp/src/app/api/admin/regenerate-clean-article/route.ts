/**
 * C-028 批量重生成脏文章（含 <think>/<thinking>/<scratchpad> reasoning 残留）
 *
 * 鉴权：Authorization: Bearer ${CRON_SECRET}（与 /api/cron/* 一致）
 *
 * GET  /api/admin/regenerate-clean-article         → 列出所有 dirty 文章
 * POST /api/admin/regenerate-clean-article         body: { id: "1203" } → 单篇重生成
 *
 * 设计原因：tsx 独立脚本进程下 @prisma/adapter-mariadb 出现 pool timeout 卡死
 * （原生 mariadb driver 21ms 即连上，PM2 进程内 Prisma 长期正常）。把重生成逻辑
 * 落到 PM2 进程内（即此 API），脚本只做 HTTP 客户端，绕过该 adapter 故障。
 *
 * 重生成行为（与脚本里既定默认值一致）：
 * - 保留原 title / slug / publish_site_id / tracking_link（外站 URL 不变）
 * - 仅覆盖 content / excerpt / meta_title / meta_description / category
 * - status=published 且未 deleted 的，重推外站覆盖
 * - is_deleted=1 且 status=failed 的：恢复 is_deleted=0 + status=preview（C-028 中的 1215/1230）
 * - is_deleted=1 且 status≠failed 的（老作废）：保留 is_deleted=1 与原 status，仅洗内容
 * - 若新生成 content 仍含 reasoning 残留 → 视为修复未生效，返回 5xx 不写 DB
 */

import { NextRequest, NextResponse } from "next/server";
import prisma from "@/lib/prisma";
import { analyzeUrl, generateMerchantArticle } from "@/lib/article-gen";
import { publishArticleToSite, verifyConnection } from "@/lib/remote-publisher";

const CRON_SECRET = process.env.CRON_SECRET || "";

function authorize(req: NextRequest): boolean {
  if (!CRON_SECRET) return false;
  const auth = req.headers.get("authorization");
  return auth === `Bearer ${CRON_SECRET}`;
}

function isDirty(content: string | null): boolean {
  if (!content) return false;
  return /<(?:think|thinking|scratchpad|reasoning|reflection|analysis|plan)\b/i.test(content);
}

async function ensureVerifiedSite(siteId: bigint) {
  const site = await prisma.publish_sites.findFirst({
    where: { id: siteId, is_deleted: 0, status: "active" },
  });
  if (!site || !site.site_path || !site.domain) return null;

  const checks = await verifyConnection(site.site_path);
  if (!checks.valid) return null;

  return {
    site_path: site.site_path,
    site_type: checks.site_type ?? site.site_type ?? null,
    data_js_path: checks.data_js_path ?? site.data_js_path ?? null,
    article_var_name: checks.article_var_name ?? site.article_var_name ?? null,
    article_html_pattern: checks.article_html_pattern ?? site.article_html_pattern ?? null,
    domain: site.domain,
  };
}

export async function GET(req: NextRequest) {
  if (!authorize(req)) {
    return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
  }
  const { searchParams } = new URL(req.url);
  const includeDeleted = searchParams.get("includeDeleted") === "1";

  const where: Record<string, unknown> = {};
  if (!includeDeleted) where.is_deleted = 0;

  const all = await prisma.articles.findMany({
    where: where as never,
    orderBy: { id: "asc" },
    select: {
      id: true,
      title: true,
      slug: true,
      status: true,
      is_deleted: true,
      publish_site_id: true,
      created_at: true,
      content: true,
    },
  });

  const dirty = all
    .filter((a) => isDirty(a.content))
    .map((a) => ({
      id: a.id.toString(),
      title: a.title,
      slug: a.slug,
      status: a.status,
      is_deleted: a.is_deleted,
      publish_site_id: a.publish_site_id ? a.publish_site_id.toString() : null,
      created_at: a.created_at,
    }));

  return NextResponse.json({ ok: true, scanned: all.length, dirty_count: dirty.length, dirty });
}

export async function POST(req: NextRequest) {
  if (!authorize(req)) {
    return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
  }

  let body: { id?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ ok: false, error: "invalid json body" }, { status: 400 });
  }
  if (!body.id) {
    return NextResponse.json({ ok: false, error: "missing id" }, { status: 400 });
  }

  const articleId = BigInt(body.id);
  const a = await prisma.articles.findFirst({ where: { id: articleId } });
  if (!a) return NextResponse.json({ ok: false, error: "article not found" }, { status: 404 });
  if (!a.user_merchant_id) {
    return NextResponse.json({ ok: false, error: "article missing user_merchant_id" }, { status: 400 });
  }

  const merchant = await prisma.user_merchants.findFirst({
    where: { id: a.user_merchant_id, is_deleted: 0 },
  });
  if (!merchant) {
    return NextResponse.json({ ok: false, error: "linked merchant deleted" }, { status: 400 });
  }

  const trackingLink =
    a.tracking_link ||
    merchant.campaign_link ||
    merchant.tracking_link ||
    merchant.merchant_url ||
    "";
  if (!trackingLink) {
    return NextResponse.json({ ok: false, error: "no tracking_link available" }, { status: 400 });
  }

  const merchantUrl =
    merchant.merchant_url ||
    `https://${(merchant.merchant_name || "").toLowerCase().replace(/\s+/g, "")}.com`;
  const country = merchant.target_country || "US";
  const images = Array.isArray(a.images) ? (a.images as string[]) : [];

  const startedAt = Date.now();
  let analysis: Awaited<ReturnType<typeof analyzeUrl>>;
  try {
    analysis = await analyzeUrl(merchantUrl, country);
  } catch (e) {
    return NextResponse.json(
      { ok: false, stage: "analyzeUrl", error: e instanceof Error ? e.message : String(e) },
      { status: 500 },
    );
  }

  const title = a.title || analysis.titles[0]?.titleEn || `${merchant.merchant_name} Review`;

  let result: Awaited<ReturnType<typeof generateMerchantArticle>>;
  try {
    result = await generateMerchantArticle({
      title,
      merchantName: analysis.brandName || merchant.merchant_name,
      merchantUrl,
      trackingLink,
      country,
      products: analysis.products,
      sellingPoints: analysis.sellingPoints,
      keywords: analysis.keywords,
      images,
      userId: a.user_id,
    });
  } catch (e) {
    return NextResponse.json(
      { ok: false, stage: "generateMerchantArticle", error: e instanceof Error ? e.message : String(e) },
      { status: 500 },
    );
  }

  if (isDirty(result.content)) {
    return NextResponse.json(
      {
        ok: false,
        stage: "self-check",
        error: "新生成 content 仍含 reasoning 残留（修复未生效？）",
        contentHead: result.content.slice(0, 300),
      },
      { status: 500 },
    );
  }

  await prisma.articles.update({
    where: { id: a.id },
    data: {
      content: result.content,
      excerpt: result.excerpt,
      meta_title: result.metaTitle,
      meta_description: result.metaDescription,
      category: result.category || "general",
      updated_at: new Date(),
    },
  });

  let repushed = false;
  let publishedUrl: string | null = null;
  let restoredFromDeleted = false;

  if (a.status === "published" && a.publish_site_id && a.is_deleted === 0) {
    const site = await ensureVerifiedSite(a.publish_site_id);
    if (!site) {
      return NextResponse.json({
        ok: true,
        articleId: body.id,
        durationMs: Date.now() - startedAt,
        contentLen: result.content.length,
        repushed: false,
        warning: `publish_site ${a.publish_site_id} 未验证，跳过外站重推（DB 已更新）`,
      });
    }
    const publishRes = await publishArticleToSite(
      {
        id: String(a.id),
        title,
        slug: a.slug || "",
        content: result.content,
        category: result.category || "General",
        images: a.images,
        trackingLink,
      },
      site,
    );
    if (!publishRes.success) {
      return NextResponse.json(
        {
          ok: false,
          stage: "publishArticleToSite",
          error: publishRes.error || "publish failed",
          articleId: body.id,
        },
        { status: 500 },
      );
    }
    await prisma.articles.update({
      where: { id: a.id },
      data: {
        content: publishRes.updatedContent || result.content,
        published_url: publishRes.url || undefined,
      },
    });
    repushed = true;
    publishedUrl = publishRes.url || null;
  } else if (a.is_deleted === 1 && a.status === "failed") {
    await prisma.articles.update({
      where: { id: a.id },
      data: { is_deleted: 0, status: "preview", updated_at: new Date() },
    });
    restoredFromDeleted = true;
  }
  // 其它 is_deleted=1 的（老作废，status=preview/published 等）：仅洗内容，不改状态

  return NextResponse.json({
    ok: true,
    articleId: body.id,
    durationMs: Date.now() - startedAt,
    contentLen: result.content.length,
    repushed,
    publishedUrl,
    restoredFromDeleted,
    title,
    slug: a.slug,
  });
}
