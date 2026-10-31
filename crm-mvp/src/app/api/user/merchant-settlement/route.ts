import { NextRequest } from "next/server";
import { withUser } from "@/lib/api-handler";
import { apiSuccess, apiError } from "@/lib/constants";
import { serializeData } from "@/lib/auth";
import prisma from "@/lib/prisma";

/**
 * D-374 商家结算率表（用户端只读查询）
 * GET ?search=&platform=&page=&pageSize= → 结算率表清单，并与当前用户的商家库比对，
 * 标 can_run（商家在 user_merchants 里已被任意平台账号认领，不要求联盟平台一致）。
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
        select: { merchant_name: true, status: true, platform: true },
      })
    : [];

  // 不限平台，只按商家名（小写）比对；同名多条优先保留"已认领"的那条
  const byName = new Map<string, (typeof mine)[0]>();
  for (const m of mine) {
    const k = m.merchant_name.toLowerCase();
    const prev = byName.get(k);
    if (!prev || (prev.status === "available" && m.status !== "available")) byName.set(k, m);
  }

  const enriched = items.map((it) => {
    const match = byName.get(it.merchant_name.toLowerCase());
    const myStatus = match ? match.status : null;
    return {
      ...it,
      my_status: myStatus, // null=未入库 / available=可认领 / 其余=可直接跑
      my_platform: match ? match.platform : null,
      can_run: myStatus != null && myStatus !== "available",
    };
  });

  return apiSuccess(serializeData({ items: enriched, total, page, pageSize }));
});
