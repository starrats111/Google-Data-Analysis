import { withUser } from "@/lib/api-handler";
import { apiSuccess } from "@/lib/constants";
import { serializeData } from "@/lib/auth";
import prisma from "@/lib/prisma";
import { NODE_SOURCE, daysUntilNode } from "@/lib/holiday-nodes";

/**
 * D-278 节点日历（用户端只读）
 * 返回启用节点 + 距今天数 + 清单商家数 + 是否在提醒窗口内。
 * 已过去超过 7 天的节点不返回（等管理员改到下一届日期后自然回来）。
 */
export const GET = withUser(async () => {
  const nodes = await prisma.holiday_nodes.findMany({
    where: { enabled: 1, is_deleted: 0 },
    orderBy: { node_date: "asc" },
  });
  const counts = await prisma.merchant_recommendations.groupBy({
    by: ["node_code"],
    where: { source: NODE_SOURCE, is_deleted: 0, node_code: { not: null } },
    _count: true,
  });
  const countMap = new Map(counts.map((c) => [c.node_code, c._count]));

  const items = nodes
    .map((n) => {
      const days = daysUntilNode(n.node_date);
      return {
        code: n.code,
        name: n.name,
        node_date: n.node_date.toISOString().slice(0, 10),
        countries: n.countries,
        lead_days: n.lead_days,
        categories: (Array.isArray(n.categories) ? n.categories : []) as string[],
        description: n.description,
        days_until: days,
        in_window: days >= 0 && days <= n.lead_days,
        list_count: countMap.get(n.code) || 0,
      };
    })
    .filter((n) => n.days_until >= -7)
    .sort((a, b) => a.days_until - b.days_until);

  return apiSuccess(serializeData({ items }));
});
