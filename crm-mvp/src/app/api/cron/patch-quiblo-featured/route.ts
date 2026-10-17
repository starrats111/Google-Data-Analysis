/**
 * GET /api/cron/patch-quiblo-featured — D-370：quiblo.top「精选文章」兜底补丁
 *
 * 背景：quiblo.top 首页的「精选文章」区块按 post.featured === true 筛选，
 * 而 CRM 文章数据模型里没有这个字段，永远筛不出来。01 选的方案：筛不出来就
 * 退回展示最新 3 篇。
 *
 * 这不是数据文件损坏，script.js 是站点自带的渲染器、从未被 CRM 写过——
 * 所以是独立于 /api/cron/repair-site-data 的一次性补丁，不接进日常巡检/修复
 * 管线——只对 quiblo.top 这一处逻辑缺口生效，不是通用修复能力。
 */
import { NextRequest, NextResponse } from "next/server";
import prisma from "@/lib/prisma";
import { patchQuibloSiteFeaturedFallback } from "@/lib/remote-publisher";

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
      where: { domain: { contains: "quiblo.top" } },
      select: { site_path: true },
    });
    if (!site?.site_path) {
      return NextResponse.json(
        { ok: false, error: "publish_sites 里找不到 quiblo.top 或 site_path 为空" },
        { status: 404 },
      );
    }

    const result = await patchQuibloSiteFeaturedFallback(site.site_path);
    return NextResponse.json(result);
  } catch (err) {
    return NextResponse.json(
      { ok: false, error: err instanceof Error ? err.message : String(err) },
      { status: 500 },
    );
  }
}
