/**
 * GET /api/cron/patch-omniluxe-fields — D-370：omniluxe.top 字段名不匹配一次性补丁
 *
 * 背景：该站数据+渲染器同住 assets/app.js，原模板字段是 categories（数组）+
 * articleUrl + displayDate。CRM 发布新文章时曾直接用标准字段（category 字符串
 * + detailUrl）插入，和旧条目字段名对不上，渲染器对新条目跑
 * post.categories.join() 时因 categories 是 undefined 直接报 TypeError，
 * 整个渲染函数中断，首页列表容器保持空。
 *
 * 这不是数据文件损坏（语法完好、渲染器完好），repairSiteDataFile 的日常
 * 巡检管线本就不会碰它——所以是独立的一次性补丁，转换线上已有的脏条目。
 * publishArticleToSite 已经改用 adaptEntryToHomepageSchema 适配新插入的
 * 条目，往后不会再有新的脏数据产生。
 */
import { NextRequest, NextResponse } from "next/server";
import prisma from "@/lib/prisma";
import { fixOmniluxeSiteFieldMismatch } from "@/lib/remote-publisher";

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
      where: { domain: { contains: "omniluxe.top" } },
      select: { site_path: true },
    });
    if (!site?.site_path) {
      return NextResponse.json(
        { ok: false, error: "publish_sites 里找不到 omniluxe.top 或 site_path 为空" },
        { status: 404 },
      );
    }

    const result = await fixOmniluxeSiteFieldMismatch(site.site_path);
    return NextResponse.json(result);
  } catch (err) {
    return NextResponse.json(
      { ok: false, error: err instanceof Error ? err.message : String(err) },
      { status: 500 },
    );
  }
}
