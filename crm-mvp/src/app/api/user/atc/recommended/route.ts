/**
 * C-094.6 推荐广告主：跨用户分享的同行广告主
 *
 * GET /api/user/atc/recommended?page=&page_size=&q=
 *
 * 数据源：user_atc_watchlist WHERE is_shared=1 AND is_deleted=0
 *   - 按 (advertiser_id, region) 去重
 *   - 聚合 shared_by 列表（display_name），并附带 shared_count、last_shared_at
 *   - LEFT JOIN atc_advertiser_domain_snapshot 取分类信息
 *   - watched_by_me 标记当前用户是否已经关注
 *   - 自己分享给自己的不算（避免「分享给我自己」的诡异列表）
 */
import { NextRequest, NextResponse } from "next/server";
import { withUser } from "@/lib/api-handler";
import prisma from "@/lib/prisma";

interface Row {
  advertiser_id: string;
  region: string;
  advertiser_name: string | null;
  shared_count: number;
  last_shared_at: Date;
  shared_by_ids: string;
}

export const GET = withUser(async (req: NextRequest, { user }) => {
  const userId = BigInt(user.userId);
  const url = new URL(req.url);
  const page = Math.max(1, parseInt(url.searchParams.get("page") || "1", 10) || 1);
  const pageSize = Math.min(200, Math.max(10, parseInt(url.searchParams.get("page_size") || "50", 10) || 50));
  const q = (url.searchParams.get("q") ?? "").trim();

  // 1. 聚合：按 (advertiser_id, region) 分组，统计分享人数、最后分享时间、分享人 id 列表
  //    用 GROUP_CONCAT 把 user_id 拼成字符串，后续解析成数组再 LEFT JOIN users 取 display_name
  const qPattern = q ? `%${q}%` : null;
  const baseSql = `
    SELECT
      w.advertiser_id,
      w.region,
      MAX(w.advertiser_name) AS advertiser_name,
      COUNT(DISTINCT w.user_id) AS shared_count,
      MAX(w.updated_at) AS last_shared_at,
      GROUP_CONCAT(DISTINCT w.user_id ORDER BY w.updated_at DESC SEPARATOR ',') AS shared_by_ids
    FROM user_atc_watchlist w
    WHERE w.is_shared = 1
      AND w.is_deleted = 0
      AND w.user_id != ?
      ${qPattern ? "AND (w.advertiser_id LIKE ? OR w.advertiser_name LIKE ?)" : ""}
    GROUP BY w.advertiser_id, w.region
  `;

  // 总数（聚合后的行数）
  const countSql = `SELECT COUNT(*) AS total FROM (${baseSql}) AS t`;
  // 数据
  const dataSql = `${baseSql} ORDER BY shared_count DESC, last_shared_at DESC LIMIT ? OFFSET ?`;

  const countArgs: unknown[] = [userId];
  const dataArgs: unknown[] = [userId];
  if (qPattern) {
    countArgs.push(qPattern, qPattern);
    dataArgs.push(qPattern, qPattern);
  }
  dataArgs.push(pageSize, (page - 1) * pageSize);

  const [totalRows, dataRows] = await Promise.all([
    prisma.$queryRawUnsafe<Array<{ total: bigint }>>(countSql, ...countArgs),
    prisma.$queryRawUnsafe<Row[]>(dataSql, ...dataArgs),
  ]);

  const total = Number(totalRows[0]?.total ?? 0);

  if (dataRows.length === 0) {
    return NextResponse.json({
      code: 0,
      data: { total, page, page_size: pageSize, items: [] },
    });
  }

  // 2. LEFT JOIN snapshot 取分类信息
  const pairs = dataRows.map((r) => ({ advertiser_id: r.advertiser_id, region: r.region }));
  const snapRows = await prisma.atc_advertiser_domain_snapshot.findMany({
    where: { OR: pairs.map((p) => ({ advertiser_id: p.advertiser_id, region: p.region })) },
    select: {
      advertiser_id: true, region: true,
      qualifying_domain_count: true, unique_domain_count: true, ad_count: true,
    },
  });
  const snapMap = new Map(snapRows.map((s) => [`${s.advertiser_id}|${s.region}`, s]));

  // 3. 取当前用户已经关注的 (advertiser_id, region) 集合
  const myWatched = await prisma.user_atc_watchlist.findMany({
    where: {
      user_id: userId,
      is_deleted: 0,
      OR: pairs.map((p) => ({ advertiser_id: p.advertiser_id, region: p.region })),
    },
    select: { advertiser_id: true, region: true },
  });
  const myWatchedSet = new Set(myWatched.map((w) => `${w.advertiser_id}|${w.region}`));

  // 4. 解析 shared_by_ids → 查 users.display_name
  const allUserIds = new Set<string>();
  for (const r of dataRows) {
    for (const idStr of (r.shared_by_ids ?? "").split(",").filter(Boolean)) {
      allUserIds.add(idStr);
    }
  }
  const usersList = await prisma.users.findMany({
    where: { id: { in: Array.from(allUserIds).map((s) => BigInt(s)) } },
    select: { id: true, username: true, display_name: true },
  });
  const userMap = new Map(usersList.map((u) => [u.id.toString(), { display_name: u.display_name || u.username }]));

  // 5. 组装返回
  const items = dataRows.map((r) => {
    const sharedByIds = (r.shared_by_ids ?? "").split(",").filter(Boolean);
    const shared_by = sharedByIds.slice(0, 10).map((uid) => ({
      user_id: uid,
      display_name: userMap.get(uid)?.display_name || `用户${uid}`,
    }));
    const snap = snapMap.get(`${r.advertiser_id}|${r.region}`);
    return {
      advertiser_id: r.advertiser_id,
      advertiser_name: r.advertiser_name,
      region: r.region,
      shared_count: Number(r.shared_count),
      shared_by,
      last_shared_at: r.last_shared_at,
      qualifying_domain_count: snap?.qualifying_domain_count ?? null,
      unique_domain_count: snap?.unique_domain_count ?? null,
      ad_count: snap?.ad_count ?? null,
      watched_by_me: myWatchedSet.has(`${r.advertiser_id}|${r.region}`),
    };
  });

  return NextResponse.json({
    code: 0,
    data: { total, page, page_size: pageSize, items },
  });
});
