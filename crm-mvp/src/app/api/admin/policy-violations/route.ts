/**
 * D-041 / Policy Hub — Admin 政策违规看板 API
 *
 * GET /api/admin/policy-violations?days=30&page=1&pageSize=50&category=&user_id=&policy_name=
 *
 * 返回：
 *   - summary: 总数 / 已修复数 / 严重度分布 / 4 大类分布
 *   - top_users: 拒登次数 top 10 用户
 *   - top_merchants: 拒登次数 top 10 商家
 *   - top_policies: 拒登次数 top 10 政策规则
 *   - rows: 详细列表（分页）
 */

import { NextRequest } from "next/server";
import { serializeData } from "@/lib/auth";
import { apiSuccess } from "@/lib/constants";
import { withAdmin } from "@/lib/api-handler";
import prisma from "@/lib/prisma";

interface ListWhere {
  submitted_at: { gte: Date };
  policy_category?: string;
  policy_name?: string;
  user_id?: bigint;
}

export const GET = withAdmin(async (req: NextRequest) => {
  const url = new URL(req.url);
  const days = Math.min(Math.max(parseInt(url.searchParams.get("days") || "30", 10), 1), 365);
  const page = Math.max(parseInt(url.searchParams.get("page") || "1", 10), 1);
  const pageSize = Math.min(Math.max(parseInt(url.searchParams.get("pageSize") || "50", 10), 1), 200);
  const category = url.searchParams.get("category") || undefined;
  const policyName = url.searchParams.get("policy_name") || undefined;
  const userIdParam = url.searchParams.get("user_id");

  const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);

  const where: ListWhere = { submitted_at: { gte: since } };
  if (category) where.policy_category = category;
  if (policyName) where.policy_name = policyName;
  if (userIdParam) where.user_id = BigInt(userIdParam);

  // summary
  const total = await prisma.policy_violations.count({ where });
  const resolved = await prisma.policy_violations.count({
    where: { ...where, resolved_at: { not: null } },
  });
  const severityGroups = await prisma.policy_violations.groupBy({
    by: ["severity"],
    where,
    _count: { _all: true },
  });
  const categoryGroups = await prisma.policy_violations.groupBy({
    by: ["policy_category"],
    where,
    _count: { _all: true },
  });

  // top users
  const topUsersRaw = await prisma.policy_violations.groupBy({
    by: ["user_id"],
    where,
    _count: { _all: true },
    orderBy: { _count: { user_id: "desc" } },
    take: 10,
  });
  const topUserIds = topUsersRaw.map((u) => u.user_id).filter((v): v is bigint => v != null);
  const userMap = new Map<string, string>();
  if (topUserIds.length > 0) {
    const users = await prisma.users.findMany({
      where: { id: { in: topUserIds } },
      select: { id: true, username: true, display_name: true },
    });
    for (const u of users) {
      userMap.set(String(u.id), u.display_name || u.username);
    }
  }

  // top merchants
  const topMerchantsRaw = await prisma.policy_violations.groupBy({
    by: ["user_merchant_id"],
    where,
    _count: { _all: true },
    orderBy: { _count: { user_merchant_id: "desc" } },
    take: 10,
  });
  const topMerchantIds = topMerchantsRaw
    .map((m) => m.user_merchant_id)
    .filter((v): v is bigint => v != null);
  const merchantMap = new Map<string, { name: string; url: string | null }>();
  if (topMerchantIds.length > 0) {
    const merchants = await prisma.user_merchants.findMany({
      where: { id: { in: topMerchantIds } },
      select: { id: true, merchant_name: true, merchant_url: true },
    });
    for (const um of merchants) {
      merchantMap.set(String(um.id), { name: um.merchant_name || `merchant#${um.id}`, url: um.merchant_url });
    }
  }

  // top policies
  const topPolicies = await prisma.policy_violations.groupBy({
    by: ["policy_name", "policy_label_zh", "policy_category", "policy_official_url"],
    where,
    _count: { _all: true },
    orderBy: { _count: { policy_name: "desc" } },
    take: 10,
  });

  // rows (paginated)
  const rows = await prisma.policy_violations.findMany({
    where,
    orderBy: { submitted_at: "desc" },
    skip: (page - 1) * pageSize,
    take: pageSize,
  });

  return apiSuccess(
    serializeData({
      summary: {
        total,
        resolved,
        unresolved: total - resolved,
        days,
        severity_distribution: severityGroups.map((s) => ({ severity: s.severity, count: s._count._all })),
        category_distribution: categoryGroups.map((c) => ({ category: c.policy_category, count: c._count._all })),
      },
      top_users: topUsersRaw.map((u) => ({
        user_id: u.user_id,
        username: u.user_id != null ? userMap.get(String(u.user_id)) || `user#${u.user_id}` : "未知",
        count: u._count._all,
      })),
      top_merchants: topMerchantsRaw.map((m) => ({
        user_merchant_id: m.user_merchant_id,
        merchant_name: m.user_merchant_id != null
          ? merchantMap.get(String(m.user_merchant_id))?.name || `merchant#${m.user_merchant_id}`
          : "未知",
        merchant_url: m.user_merchant_id != null
          ? merchantMap.get(String(m.user_merchant_id))?.url || null
          : null,
        count: m._count._all,
      })),
      top_policies: topPolicies.map((p) => ({
        policy_name: p.policy_name,
        policy_label_zh: p.policy_label_zh,
        policy_category: p.policy_category,
        policy_official_url: p.policy_official_url,
        count: p._count._all,
      })),
      pagination: { page, pageSize, total },
      rows,
    }),
  );
});
