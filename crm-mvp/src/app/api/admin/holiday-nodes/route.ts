import { NextRequest } from "next/server";
import { withAdmin } from "@/lib/api-handler";
import { apiSuccess, apiError } from "@/lib/constants";
import { serializeData } from "@/lib/auth";
import prisma from "@/lib/prisma";
import { NODE_SOURCE, daysUntilNode } from "@/lib/holiday-nodes";

/**
 * D-278 节点日历管理（管理员）
 * GET    → 全部节点（含软删外）+ 各节点清单商家数
 * POST   → 新建/更新节点（带 id 为更新；改 node_date 时自动清 notified_at 复位提醒）
 * DELETE → 软删（?id=）
 */
export const GET = withAdmin(async () => {
  const nodes = await prisma.holiday_nodes.findMany({
    where: { is_deleted: 0 },
    orderBy: { node_date: "asc" },
  });
  const counts = await prisma.merchant_recommendations.groupBy({
    by: ["node_code"],
    where: { source: NODE_SOURCE, is_deleted: 0, node_code: { not: null } },
    _count: true,
  });
  const countMap = new Map(counts.map((c) => [c.node_code, c._count]));
  const items = nodes.map((n) => ({
    ...n,
    list_count: countMap.get(n.code) || 0,
    days_until: daysUntilNode(n.node_date),
  }));
  return apiSuccess(serializeData({ items }));
});

export const POST = withAdmin(async (req: NextRequest) => {
  const body = await req.json().catch(() => null);
  if (!body) return apiError("请求体格式错误");

  const { id, code, name, node_date, countries, lead_days, categories, description, enabled } = body as {
    id?: string | number;
    code?: string;
    name?: string;
    node_date?: string;
    countries?: string | null;
    lead_days?: number;
    categories?: string[] | null;
    description?: string | null;
    enabled?: number;
  };

  if (!name || !node_date) return apiError("节点名称与日期必填");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(node_date)) return apiError("日期格式应为 YYYY-MM-DD");
  const lead = Math.min(Math.max(Number(lead_days ?? 30) || 30, 1), 120);
  const cats = Array.isArray(categories) ? categories.map((c) => String(c).trim()).filter(Boolean) : undefined;

  const data = {
    name,
    node_date: new Date(`${node_date}T00:00:00Z`),
    countries: countries?.trim() || null,
    lead_days: lead,
    ...(cats !== undefined ? { categories: cats } : {}),
    description: description?.trim() || null,
    enabled: enabled === 0 ? 0 : 1,
  };

  if (id) {
    const existing = await prisma.holiday_nodes.findUnique({ where: { id: BigInt(id) } });
    if (!existing || existing.is_deleted) return apiError("节点不存在");
    const dateChanged = existing.node_date.toISOString().slice(0, 10) !== node_date;
    const updated = await prisma.holiday_nodes.update({
      where: { id: BigInt(id) },
      // 日期变更 = 进入下一届，清掉本届已提醒标记让提醒窗口复位
      data: { ...data, ...(dateChanged ? { notified_at: null } : {}) },
    });
    return apiSuccess(serializeData(updated), "节点已更新");
  }

  if (!code || !/^[a-z0-9_]{2,32}$/.test(code)) return apiError("code 必填，格式为小写字母/数字/下划线");
  const dup = await prisma.holiday_nodes.findUnique({ where: { code } });
  if (dup && !dup.is_deleted) return apiError(`code "${code}" 已存在`);
  if (dup) {
    // 软删过的同 code 节点直接复活并覆盖
    const revived = await prisma.holiday_nodes.update({
      where: { code },
      data: { ...data, is_deleted: 0, notified_at: null },
    });
    return apiSuccess(serializeData(revived), "节点已创建");
  }
  const created = await prisma.holiday_nodes.create({ data: { code, ...data } });
  return apiSuccess(serializeData(created), "节点已创建");
});

export const DELETE = withAdmin(async (req: NextRequest) => {
  const id = new URL(req.url).searchParams.get("id");
  if (!id) return apiError("缺少 id");
  await prisma.holiday_nodes.update({
    where: { id: BigInt(id) },
    data: { is_deleted: 1, enabled: 0 },
  });
  return apiSuccess(null, "节点已删除");
});
