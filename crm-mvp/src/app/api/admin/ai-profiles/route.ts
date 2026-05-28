/**
 * D-046.A IntelliCenter — admin AI 画像列表 API
 *
 * GET /api/admin/ai-profiles?page=1&pageSize=50&industry=&risk=&source=&search=&user_id=
 *
 * 返回结构：
 *   {
 *     code: 0,
 *     data: {
 *       summary: { total, by_source: {none, ai_backfill, manual, ...}, by_risk: {...}, by_industry: top 10 },
 *       pagination: { page, pageSize, total },
 *       rows: [{ id, merchant_name, platform, user_id, username, industry_category, compliance_risk_level, profile_source, profile_updated_at }]
 *     }
 *   }
 */
import { NextRequest, NextResponse } from "next/server";
import { withAdmin } from "@/lib/api-handler";
import prisma from "@/lib/prisma";
import { serializeData } from "@/lib/auth";

interface ProfileListItem {
  id: string;
  merchant_name: string;
  platform: string;
  merchant_id: string;
  merchant_url: string | null;
  user_id: string;
  username: string | null;
  industry_category: string | null;
  industry_subcategory: string | null;
  compliance_risk_level: string;
  trademark_authorization_status: string;
  profile_source: string;
  profile_updated_at: string | null;
}

export const GET = withAdmin(async (req: NextRequest) => {
  const { searchParams } = new URL(req.url);
  const page = Math.max(1, Number.parseInt(searchParams.get("page") || "1", 10));
  const pageSize = Math.max(
    1,
    Math.min(200, Number.parseInt(searchParams.get("pageSize") || "50", 10)),
  );
  const industry = (searchParams.get("industry") || "").trim();
  const risk = (searchParams.get("risk") || "").trim();
  const source = (searchParams.get("source") || "").trim();
  const search = (searchParams.get("search") || "").trim();
  const userIdStr = (searchParams.get("user_id") || "").trim();

  const where: Record<string, unknown> = { is_deleted: 0 };
  if (industry) where.industry_category = industry;
  if (risk) where.compliance_risk_level = risk;
  if (source) where.profile_source = source;
  if (search) {
    where.OR = [
      { merchant_name: { contains: search } },
      { merchant_url: { contains: search } },
      { merchant_id: { contains: search } },
    ];
  }
  if (userIdStr && /^\d+$/.test(userIdStr)) {
    where.user_id = BigInt(userIdStr);
  }

  // 主列表查询
  const [total, rows] = await Promise.all([
    prisma.user_merchants.count({ where: where as never }),
    prisma.user_merchants.findMany({
      where: where as never,
      select: {
        id: true,
        merchant_name: true,
        platform: true,
        merchant_id: true,
        merchant_url: true,
        user_id: true,
        industry_category: true,
        industry_subcategory: true,
        compliance_risk_level: true,
        trademark_authorization_status: true,
        profile_source: true,
        profile_updated_at: true,
      },
      orderBy: [{ profile_updated_at: "desc" }, { id: "desc" }],
      skip: (page - 1) * pageSize,
      take: pageSize,
    }),
  ]);

  // 拉 username 映射
  const userIds = Array.from(
    new Set(rows.map((r) => r.user_id)),
  );
  const users =
    userIds.length > 0
      ? await prisma.users.findMany({
          where: { id: { in: userIds } },
          select: { id: true, username: true },
        })
      : [];
  const userMap = new Map(users.map((u) => [String(u.id), u.username]));

  // 汇总统计（不分页：基于当前 where 过滤后的全集）
  const [bySource, byRisk, byIndustryRaw] = await Promise.all([
    prisma.user_merchants.groupBy({
      by: ["profile_source"],
      where: where as never,
      _count: { _all: true },
    }),
    prisma.user_merchants.groupBy({
      by: ["compliance_risk_level"],
      where: where as never,
      _count: { _all: true },
    }),
    prisma.user_merchants.groupBy({
      by: ["industry_category"],
      where: where as never,
      _count: { _all: true },
      orderBy: { _count: { id: "desc" } },
      take: 12,
    }),
  ]);

  const items: ProfileListItem[] = rows.map((r) => ({
    id: r.id.toString(),
    merchant_name: r.merchant_name,
    platform: r.platform,
    merchant_id: r.merchant_id,
    merchant_url: r.merchant_url,
    user_id: r.user_id.toString(),
    username: userMap.get(String(r.user_id)) || null,
    industry_category: r.industry_category,
    industry_subcategory: r.industry_subcategory,
    compliance_risk_level: r.compliance_risk_level,
    trademark_authorization_status: r.trademark_authorization_status,
    profile_source: r.profile_source,
    profile_updated_at: r.profile_updated_at
      ? r.profile_updated_at.toISOString()
      : null,
  }));

  return NextResponse.json({
    code: 0,
    data: serializeData({
      summary: {
        total,
        by_source: bySource.map((g) => ({
          key: g.profile_source,
          count: g._count._all,
        })),
        by_risk: byRisk.map((g) => ({
          key: g.compliance_risk_level,
          count: g._count._all,
        })),
        by_industry: byIndustryRaw.map((g) => ({
          key: g.industry_category || "uncategorized",
          count: g._count._all,
        })),
      },
      pagination: { page, pageSize, total },
      rows: items,
    }),
  });
});
