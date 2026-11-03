import { NextRequest } from "next/server";
import { withUser } from "@/lib/api-handler";
import { apiSuccess, apiError } from "@/lib/constants";
import { serializeData } from "@/lib/auth";
import prisma from "@/lib/prisma";

/**
 * D-374 商家结算率表（用户端只读查询）
 * GET ?search=&platform=&page=&pageSize= → 结算率表清单，并与当前用户的商家库比对，
 * 标 can_run（该行的「平台+MID」在 user_merchants 里有对应记录，且挂着真正在投放——即
 * google_status=ENABLED——的广告系列）。
 *
 * D-376 修正：同名商家在不同联盟平台是完全独立的商家（不同 MID、不同结算率、
 * 认领状态各自独立，如 Hill House Home 在 CG/BSH/MUI/LB/QUK 各有一条）。
 * 之前只按商家名比对、不分平台，会把结算率表里"BSH 行"错配成用户在"MUI"下的认领记录，
 * 显示"可直接跑"但实际那个平台根本没有这个商家。
 * 现改为：有 MID 的行按「平台+MID」精确匹配；MID 缺失时退化为「平台+商家名」匹配（仍不跨平台）。
 * 「认领」≠「在跑」：claimed 只代表曾经认领，广告可能已被暂停/下架，
 * 判定口径对齐 active-running.ts 的"在跑"定义（google_status=ENABLED）。
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

  const platforms = Array.from(new Set(items.map((i) => i.platform)));
  const names = items.map((i) => i.merchant_name);
  const mine = platforms.length > 0
    ? await prisma.user_merchants.findMany({
        where: { user_id: userId, is_deleted: 0, platform: { in: platforms }, merchant_name: { in: names } },
        select: { id: true, merchant_name: true, merchant_id: true, status: true, platform: true },
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

  // D-376：同名商家跨平台是不同商家，必须同平台才算同一商家。
  // 有 MID 时按「平台+MID」精确匹配；MID 缺失时退化为「平台+商家名」（仍不跨平台）
  const rank = (m: (typeof mine)[0]) =>
    enabledSet.has(m.id.toString()) ? 2 : m.status !== "available" ? 1 : 0;
  const byMid = new Map<string, (typeof mine)[0]>();
  const byPlatName = new Map<string, (typeof mine)[0]>();
  for (const m of mine) {
    if (m.merchant_id) {
      const k = `${m.platform}:${m.merchant_id}`;
      const prev = byMid.get(k);
      if (!prev || rank(m) > rank(prev)) byMid.set(k, m);
    }
    const nk = `${m.platform}:${m.merchant_name.toLowerCase()}`;
    const prevN = byPlatName.get(nk);
    if (!prevN || rank(m) > rank(prevN)) byPlatName.set(nk, m);
  }

  const enriched = items.map((it) => {
    const match =
      (it.mid ? byMid.get(`${it.platform}:${it.mid}`) : undefined) ||
      byPlatName.get(`${it.platform}:${it.merchant_name.toLowerCase()}`);
    const myStatus = match ? match.status : null;
    const running = match ? enabledSet.has(match.id.toString()) : false;
    return {
      ...it,
      my_status: myStatus, // null=未入库 / available=可认领 / claimed/paused=已认领但未必在投
      my_platform: match ? match.platform : null,
      can_run: running, // 必须同平台+MID 匹配上，且有真正 ENABLED 的广告系列
    };
  });

  return apiSuccess(serializeData({ items: enriched, total, page, pageSize }));
});
