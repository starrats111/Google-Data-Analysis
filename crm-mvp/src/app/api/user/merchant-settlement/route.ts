import { NextRequest } from "next/server";
import { withUser } from "@/lib/api-handler";
import { apiSuccess, apiError } from "@/lib/constants";
import { serializeData } from "@/lib/auth";
import prisma from "@/lib/prisma";

/**
 * D-374 商家结算率表（用户端只读查询）
 * GET ?search=&platform=&page=&pageSize= → 结算率表清单，并与当前用户的商家库比对，
 * 标 can_run（商家名在 user_merchants 任意平台下有一条真正在投放——即挂着 google_status=ENABLED
 * 的广告系列，不要求联盟平台一致）。
 * 「认领」≠「在跑」：wj04 反馈过"显示可直接跑但实际已下架"——claimed 只代表曾经认领，
 * 广告可能早已被暂停/下架，判定口径对齐 active-running.ts 的"在跑"定义（google_status=ENABLED）。
 * 数据由管理员通过 /api/admin/merchant-settlement-upload 上传。
 */
export const GET = withUser(async (req: NextRequest, { user }) => {
  const { searchParams } = new URL(req.url);
  const search = searchParams.get("search") || "";
  const platform = searchParams.get("platform") || "";
  const page = parseInt(searchParams.get("page") || "1");
  const pageSize = parseInt(searchParams.get("pageSize") || "50");
  const userId = BigInt(user.userId);

  const where: Record<string, unknown> = { is_deleted: 0 };
  if (search) where.merchant_name = { contains: search };
  if (platform) where.platform = platform;

  const [total, items] = await Promise.all([
    prisma.merchant_settlement_rates.count({ where: where as never }),
    prisma.merchant_settlement_rates.findMany({
      where: where as never,
      orderBy: [{ settlement_rate: "desc" }],
      skip: (page - 1) * pageSize,
      take: pageSize,
    }),
  ]);

  const names = items.map((i) => i.merchant_name);
  const mine = names.length > 0
    ? await prisma.user_merchants.findMany({
        where: { user_id: userId, is_deleted: 0, merchant_name: { in: names } },
        select: { id: true, merchant_name: true, status: true, platform: true },
      })
    : [];

  // 无外键关联（本库不用 Prisma relation），单独查这些商家下是否有 ENABLED 系列
  const myMerchantIds = mine.map((m) => m.id);
  const enabledIds = myMerchantIds.length > 0
    ? await prisma.campaigns.findMany({
        where: { user_merchant_id: { in: myMerchantIds }, is_deleted: 0, google_status: "ENABLED" },
        select: { user_merchant_id: true },
      })
    : [];
  const enabledSet = new Set(enabledIds.map((c) => c.user_merchant_id.toString()));

  // 不限平台，只按商家名（小写）比对；同名多条优先保留"有 ENABLED 系列"的那条，其次"已认领"
  const rank = (m: (typeof mine)[0]) =>
    enabledSet.has(m.id.toString()) ? 2 : m.status !== "available" ? 1 : 0;
  const byName = new Map<string, (typeof mine)[0]>();
  for (const m of mine) {
    const k = m.merchant_name.toLowerCase();
    const prev = byName.get(k);
    if (!prev || rank(m) > rank(prev)) byName.set(k, m);
  }

  const enriched = items.map((it) => {
    const match = byName.get(it.merchant_name.toLowerCase());
    const myStatus = match ? match.status : null;
    const running = match ? enabledSet.has(match.id.toString()) : false;
    return {
      ...it,
      my_status: myStatus, // null=未入库 / available=可认领 / claimed/paused=已认领但未必在投
      my_platform: match ? match.platform : null,
      can_run: running, // 必须有真正 ENABLED 的广告系列，不只是"认领过"
    };
  });

  return apiSuccess(serializeData({ items: enriched, total, page, pageSize }));
});
