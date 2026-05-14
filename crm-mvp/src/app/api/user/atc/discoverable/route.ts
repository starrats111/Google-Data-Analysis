/**
 * C-094.6 可关注广告主：所有员工查过的同行广告主（持久化去重）
 *
 * GET /api/user/atc/discoverable?page=&page_size=&q=&min_qualifying=3
 *
 * 数据源：atc_advertiser_domain_snapshot WHERE qualifying_domain_count >= min_qualifying
 *   （这张表本身就是团队级共享缓存，按 (advertiser_id, region) 唯一约束去重）
 *   - 默认 min_qualifying=3 → 只展示同行（peer）
 *   - 排序：合格域名数 desc → ad_count desc
 *   - 自动剔除当前用户已关注的 (advertiser_id, region)（剩下的才是"可关注"）
 *   - 附带前 5 个合格域名（按 max_creative_days desc）供 UI 显示
 */
import { NextRequest, NextResponse } from "next/server";
import { withUser } from "@/lib/api-handler";
import prisma from "@/lib/prisma";
import { Prisma } from "@/generated/prisma";

interface DomainCreativeStat {
  domain: string;
  creative_count: number;
  has_long_running_creative: boolean;
  max_creative_days: number;
}

export const GET = withUser(async (req: NextRequest, { user }) => {
  const userId = BigInt(user.userId);
  const url = new URL(req.url);
  const page = Math.max(1, parseInt(url.searchParams.get("page") || "1", 10) || 1);
  const pageSize = Math.min(200, Math.max(10, parseInt(url.searchParams.get("page_size") || "50", 10) || 50));
  const q = (url.searchParams.get("q") ?? "").trim();
  const minQualifying = Math.max(1, parseInt(url.searchParams.get("min_qualifying") || "3", 10) || 3);

  // 先取当前用户所有已关注的 (advertiser_id, region)，从结果集排除
  const myWatchedAll = await prisma.user_atc_watchlist.findMany({
    where: { user_id: userId, is_deleted: 0 },
    select: { advertiser_id: true, region: true },
  });

  const where: Prisma.atc_advertiser_domain_snapshotWhereInput = {
    qualifying_domain_count: { gte: minQualifying },
  };
  if (myWatchedAll.length > 0) {
    where.NOT = {
      OR: myWatchedAll.map((w) => ({ advertiser_id: w.advertiser_id, region: w.region })),
    };
  }
  if (q) {
    where.OR = [
      { advertiser_id: { contains: q } },
      { advertiser_name: { contains: q } },
    ];
  }

  const [total, rows] = await Promise.all([
    prisma.atc_advertiser_domain_snapshot.count({ where }),
    prisma.atc_advertiser_domain_snapshot.findMany({
      where,
      orderBy: [
        { qualifying_domain_count: "desc" },
        { ad_count: "desc" },
      ],
      skip: (page - 1) * pageSize,
      take: pageSize,
      select: {
        advertiser_id: true, region: true, advertiser_name: true,
        qualifying_domain_count: true, unique_domain_count: true,
        ad_count: true, domains_json: true, fetched_at: true,
      },
    }),
  ]);

  if (rows.length === 0) {
    return NextResponse.json({
      code: 0,
      data: { total, page, page_size: pageSize, items: [] },
    });
  }

  const items = rows.map((r) => {
    // 取前 5 个合格域名（按 max_creative_days desc）
    let topQualifying: Array<{ domain: string; max_creative_days: number }> = [];
    if (Array.isArray(r.domains_json)) {
      topQualifying = (r.domains_json as unknown as DomainCreativeStat[])
        .filter((d) => d.has_long_running_creative)
        .sort((a, b) => b.max_creative_days - a.max_creative_days)
        .slice(0, 5)
        .map((d) => ({ domain: d.domain, max_creative_days: d.max_creative_days }));
    }
    return {
      advertiser_id: r.advertiser_id,
      advertiser_name: r.advertiser_name,
      region: r.region,
      qualifying_domain_count: r.qualifying_domain_count,
      unique_domain_count: r.unique_domain_count,
      ad_count: r.ad_count,
      top_qualifying_domains: topQualifying,
      fetched_at: r.fetched_at,
      watched_by_me: false, // 已关注的已在 where.NOT 排除，剩下的都是可关注
    };
  });

  return NextResponse.json({
    code: 0,
    data: { total, page, page_size: pageSize, items },
  });
});
