/**
 * C-089 / C-094.6 ATC watchlist CRUD
 *
 * GET    /api/user/atc/watchlist
 *   兼容两种调用方式：
 *     - 无任何 query：返回精简数组（旧 ATC modal 用，最多 200 条）
 *     - 带 page/page_size/q：返回分页结构 { items, total, page, page_size }（我的广告主页用）
 *   返回字段会 LEFT JOIN atc_advertiser_domain_snapshot 取 qualifying_domain_count、
 *   ad_count、unique_domain_count 等分类信息（key=advertiser_id+region）
 *
 * POST   /api/user/atc/watchlist
 *   单条新增关注，body { advertiser_id, advertiser_name?, region?, min_days? }
 *   软删过的记录复活并更新 min_days/name
 *
 * 单条删除走 /api/user/atc/watchlist/[id]/route.ts (DELETE)
 * 单条切换分享走 /api/user/atc/watchlist/[id]/route.ts (PATCH)
 * 批量关注走 /api/user/atc/watchlist/batch/route.ts
 */
import { NextRequest, NextResponse } from "next/server";
import { withUser } from "@/lib/api-handler";
import prisma from "@/lib/prisma";
import { Prisma } from "@/generated/prisma";

interface SnapshotInfo {
  advertiser_id: string;
  region: string;
  qualifying_domain_count: number;
  unique_domain_count: number;
  ad_count: number;
}

/** 批量取 (advertiser_id, region) 对应的快照分类信息 */
async function fetchSnapshots(pairs: Array<{ advertiser_id: string; region: string }>): Promise<Map<string, SnapshotInfo>> {
  const map = new Map<string, SnapshotInfo>();
  if (pairs.length === 0) return map;
  // 用 OR 拼批量查询（pairs 最多 200 条，性能足够）
  const rows = await prisma.atc_advertiser_domain_snapshot.findMany({
    where: {
      OR: pairs.map((p) => ({ advertiser_id: p.advertiser_id, region: p.region })),
    },
    select: {
      advertiser_id: true,
      region: true,
      qualifying_domain_count: true,
      unique_domain_count: true,
      ad_count: true,
    },
  });
  for (const r of rows) {
    map.set(`${r.advertiser_id}|${r.region}`, r);
  }
  return map;
}

export const GET = withUser(async (req: NextRequest, { user }) => {
  const userId = BigInt(user.userId);
  const url = new URL(req.url);
  const pageStr = url.searchParams.get("page");
  const pageSizeStr = url.searchParams.get("page_size");
  const q = (url.searchParams.get("q") ?? "").trim();

  const isPaged = pageStr !== null || pageSizeStr !== null || q.length > 0;

  if (!isPaged) {
    // 兼容旧 ATC modal：返回精简数组
    const rows = await prisma.user_atc_watchlist.findMany({
      where: { user_id: userId, is_deleted: 0 },
      orderBy: { created_at: "desc" },
      take: 200,
    });
    return NextResponse.json({
      code: 0,
      data: rows.map((r) => ({
        id: r.id.toString(),
        advertiser_id: r.advertiser_id,
        advertiser_name: r.advertiser_name,
        region: r.region,
        min_days: r.min_days,
        is_shared: r.is_shared === 1,
        created_at: r.created_at,
      })),
    });
  }

  // 分页模式
  const page = Math.max(1, parseInt(pageStr || "1", 10) || 1);
  const pageSize = Math.min(200, Math.max(10, parseInt(pageSizeStr || "50", 10) || 50));
  const where: Prisma.user_atc_watchlistWhereInput = { user_id: userId, is_deleted: 0 };
  if (q) {
    where.OR = [
      { advertiser_id: { contains: q } },
      { advertiser_name: { contains: q } },
    ];
  }

  const [total, rows] = await Promise.all([
    prisma.user_atc_watchlist.count({ where }),
    prisma.user_atc_watchlist.findMany({
      where,
      orderBy: { created_at: "desc" },
      skip: (page - 1) * pageSize,
      take: pageSize,
    }),
  ]);

  const snapMap = await fetchSnapshots(rows.map((r) => ({ advertiser_id: r.advertiser_id, region: r.region })));

  return NextResponse.json({
    code: 0,
    data: {
      total,
      page,
      page_size: pageSize,
      items: rows.map((r) => {
        const snap = snapMap.get(`${r.advertiser_id}|${r.region}`);
        return {
          id: r.id.toString(),
          advertiser_id: r.advertiser_id,
          advertiser_name: r.advertiser_name,
          region: r.region,
          min_days: r.min_days,
          is_shared: r.is_shared === 1,
          qualifying_domain_count: snap?.qualifying_domain_count ?? null,
          unique_domain_count: snap?.unique_domain_count ?? null,
          ad_count: snap?.ad_count ?? null,
          created_at: r.created_at,
        };
      }),
    },
  });
});

export const POST = withUser(async (req: NextRequest, { user }) => {
  const userId = BigInt(user.userId);
  const body = await req.json().catch(() => ({})) as {
    advertiser_id?: string;
    advertiser_name?: string;
    region?: string;
    min_days?: number;
  };

  const advertiserId = (body.advertiser_id ?? "").trim();
  const region = (body.region ?? "US").trim().toUpperCase();
  // C-094.11：未传 min_days 时从 users.atc_default_min_days 取（全局阈值）
  let minDays: number;
  if (Number.isFinite(body.min_days)) {
    minDays = Math.max(1, Math.min(365, Number(body.min_days)));
  } else {
    const u = await prisma.users.findFirst({ where: { id: userId }, select: { atc_default_min_days: true } });
    minDays = u?.atc_default_min_days ?? 30;
  }
  const advertiserName = (body.advertiser_name ?? "").trim() || null;

  if (!advertiserId.startsWith("AR")) {
    return NextResponse.json(
      { code: -1, message: "advertiser_id 必须以 AR 开头" },
      { status: 400 },
    );
  }
  if (!region) {
    return NextResponse.json({ code: -1, message: "region 必填" }, { status: 400 });
  }

  const existing = await prisma.user_atc_watchlist.findFirst({
    where: { user_id: userId, advertiser_id: advertiserId, region },
  });

  if (existing) {
    const updated = await prisma.user_atc_watchlist.update({
      where: { id: existing.id },
      data: {
        is_deleted: 0,
        advertiser_name: advertiserName ?? existing.advertiser_name,
        min_days: minDays,
      },
    });
    return NextResponse.json({
      code: 0,
      data: { id: updated.id.toString(), reactivated: existing.is_deleted === 1 },
    });
  }

  const created = await prisma.user_atc_watchlist.create({
    data: {
      user_id: userId,
      advertiser_id: advertiserId,
      advertiser_name: advertiserName,
      region,
      min_days: minDays,
    },
  });

  return NextResponse.json({
    code: 0,
    data: { id: created.id.toString(), reactivated: false },
  });
});
