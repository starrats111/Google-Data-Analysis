/**
 * GET /api/cron/patch-bloomroots-detail — D-378：bloomroots.top 详情页渲染器补丁
 *
 * 背景：article.html?title={slug} 的 #articleContent 从 D-370 重写以来一直是空的 ——
 * 当时只补了首页列表渲染器（script.js），没人写过"按 URL 参数查数据、填充详情正文"
 * 这段代码。库里文章内容完好，纯粹是没人渲染。见设计方案 D-378。
 *
 * 一次性补丁，不接进日常巡检管线——只对 bloomroots.top 这一处功能缺口生效。
 */
import { NextRequest, NextResponse } from "next/server";
import prisma from "@/lib/prisma";
import { installBloomrootsDetailRenderer } from "@/lib/remote-publisher";

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
      where: { domain: { contains: "bloomroots.top" } },
      select: { site_path: true },
    });
    if (!site?.site_path) {
      return NextResponse.json(
        { ok: false, error: "publish_sites 里找不到 bloomroots.top 或 site_path 为空" },
        { status: 404 },
      );
    }

    const result = await installBloomrootsDetailRenderer(site.site_path);
    return NextResponse.json(result);
  } catch (err) {
    return NextResponse.json(
      { ok: false, error: err instanceof Error ? err.message : String(err) },
      { status: 500 },
    );
  }
}
