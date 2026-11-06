/**
 * GET /api/cron/patch-everydaynes-text-color — D-380：everydaynes.top 详情页深色主题文字覆盖
 *
 * 背景：ARTICLE_LAYOUT_STYLE_BLOCK 的兜底色是按浅色主题设计的，everydaynes.top
 * 自己是深色主题（body 近黑）且没定义对应 CSS 变量，详情页正文/标题几乎看不清。
 * 新发布的文章已经会带上覆盖（见 remote-publisher.ts 的 articleLayoutDomainOverride），
 * 这个补丁只处理修复前已发布、HTML 已落盘的历史文章。
 *
 * 一次性补丁，不接进日常巡检管线。可传 ?slugs=a,b,c 限定范围，默认处理全部已发布文章。
 */
import { NextRequest, NextResponse } from "next/server";
import prisma from "@/lib/prisma";
import { patchEverydaynesArticleTextColor } from "@/lib/remote-publisher";

export const maxDuration = 60;

function verifyCron(req: NextRequest): boolean {
  const secret = process.env.CRON_SECRET;
  if (!secret) return false;
  return req.headers.get("authorization") === `Bearer ${secret}`;
}

export async function GET(req: NextRequest) {
  if (!verifyCron(req)) {
    return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
  }

  try {
    const site = await prisma.publish_sites.findFirst({
      where: { domain: { contains: "everydaynes.top" } },
      select: { id: true, site_path: true },
    });
    if (!site?.site_path) {
      return NextResponse.json(
        { ok: false, error: "publish_sites 里找不到 everydaynes.top 或 site_path 为空" },
        { status: 404 },
      );
    }

    const slugsParam = req.nextUrl.searchParams.get("slugs");
    const slugs = slugsParam
      ? slugsParam.split(",").map((s) => s.trim()).filter(Boolean)
      : undefined;

    const articles = await prisma.articles.findMany({
      where: {
        publish_site_id: site.id,
        status: "published",
        ...(slugs ? { slug: { in: slugs } } : {}),
      },
      select: { slug: true },
    });

    const detailDirs = articles
      .map((a) => a.slug)
      .filter((s): s is string => Boolean(s))
      .map((slug) => `post-${slug}`);

    const result = await patchEverydaynesArticleTextColor(site.site_path, detailDirs);
    return NextResponse.json(result);
  } catch (err) {
    return NextResponse.json(
      { ok: false, error: err instanceof Error ? err.message : String(err) },
      { status: 500 },
    );
  }
}
