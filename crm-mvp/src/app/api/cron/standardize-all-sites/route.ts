/**
 * GET /api/cron/standardize-all-sites — 批量把站点远程目录重新标准化为 A1
 *
 * 作用（幂等，可重复跑）：对每个站点执行 applyA1SiteStandard：
 *   - 重建文章详情页（用各站自身 index.html 作模板 + 新版精排：首字下沉/图注/主题色链接）
 *   - 仅当首页缺失/为空/为 CRM 兜底页时，写入新版「杂志风」兜底首页（站点原创设计绝不覆盖）
 *
 * 参数：
 *   ?only=<域名包含串>  仅处理域名匹配的站点（试点用）
 *   ?limit=N            本轮最多处理 N 个（默认 全部）
 *   ?offset=N           跳过前 N 个（配合 limit 分批，断点续跑）
 * 鉴权：CRON_SECRET（Authorization: Bearer ...）
 *
 * 低配机注意：串行执行，单站之间不并发。建议分批：limit=5 配合 offset 递增。
 */
import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { applyA1SiteStandard } from "@/lib/remote-publisher";

export const dynamic = "force-dynamic";
export const maxDuration = 800;

let isRunning = false;

function verifyCron(req: NextRequest): boolean {
  const secret = process.env.CRON_SECRET;
  if (!secret) return false;
  return req.headers.get("authorization") === `Bearer ${secret}`;
}

export async function GET(req: NextRequest) {
  if (!verifyCron(req)) {
    return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
  }
  if (isRunning) {
    return NextResponse.json({ ok: false, error: "another run is in progress" }, { status: 409 });
  }
  isRunning = true;
  const startedAt = Date.now();
  try {
    const url = new URL(req.url);
    const only = (url.searchParams.get("only") || "").trim().toLowerCase();
    const limit = Math.max(0, parseInt(url.searchParams.get("limit") || "0", 10) || 0);
    const offset = Math.max(0, parseInt(url.searchParams.get("offset") || "0", 10) || 0);

    const allSites = await prisma.publish_sites.findMany({
      where: { is_deleted: 0 },
      select: { id: true, domain: true, site_path: true, site_name: true, status: true },
      orderBy: { id: "asc" },
    });

    let targets = allSites.filter((s) => s.site_path && s.site_path.trim());
    if (only) targets = targets.filter((s) => (s.domain || "").toLowerCase().includes(only));
    const totalMatched = targets.length;
    if (offset) targets = targets.slice(offset);
    if (limit) targets = targets.slice(0, limit);

    const results: Array<{ id: string; domain: string; ok: boolean; merged_count?: number; error?: string; ms: number }> = [];
    let okCount = 0;
    for (const s of targets) {
      const t0 = Date.now();
      try {
        const r = await applyA1SiteStandard(s.site_path as string, s.domain || "");
        if (r.ok) okCount++;
        results.push({
          id: String(s.id),
          domain: s.domain || "",
          ok: r.ok,
          merged_count: r.merged_count ?? 0,
          error: r.ok ? undefined : r.error,
          ms: Date.now() - t0,
        });
        console.log(`[standardize-all] ${s.domain} -> ${r.ok ? "OK" : "FAIL"} (${r.merged_count ?? 0} articles, ${Date.now() - t0}ms)${r.ok ? "" : " :: " + r.error}`);
      } catch (err) {
        results.push({
          id: String(s.id),
          domain: s.domain || "",
          ok: false,
          error: err instanceof Error ? err.message : String(err),
          ms: Date.now() - t0,
        });
        console.error(`[standardize-all] ${s.domain} -> EXCEPTION`, err);
      }
    }

    return NextResponse.json({
      ok: true,
      total_matched: totalMatched,
      processed: results.length,
      succeeded: okCount,
      failed: results.length - okCount,
      offset,
      limit: limit || null,
      elapsed_ms: Date.now() - startedAt,
      results,
    });
  } catch (err) {
    return NextResponse.json(
      { ok: false, error: err instanceof Error ? err.message : String(err) },
      { status: 500 },
    );
  } finally {
    isRunning = false;
  }
}
