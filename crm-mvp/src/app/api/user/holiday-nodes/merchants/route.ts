import { NextRequest } from "next/server";
import { withUser } from "@/lib/api-handler";
import { apiSuccess, apiError } from "@/lib/constants";
import { serializeData } from "@/lib/auth";
import prisma from "@/lib/prisma";
import { NODE_SOURCE } from "@/lib/holiday-nodes";
import { normalizePlatformCode, isValidPlatformCode } from "@/lib/constants";

/**
 * D-278 节点推荐清单层（用户端）
 * GET ?code=black_friday → 该节点官方清单商家（EPC/佣金参考值），
 * 并与当前用户自己的商家库比对：在库标可认领/已认领，未入库如实标注（数据真实性规范：不造数据）。
 * 匹配口径：清单行 affiliate 能解析成平台代码时按 平台+MID 精确匹配（不同平台数字 MID 会撞号，
 * 不能只按 MID 匹配）；解析不了的按名称匹配兜底。
 */
export const GET = withUser(async (req: NextRequest, { user }) => {
  const code = new URL(req.url).searchParams.get("code") || "";
  if (!code) return apiError("缺少 code");
  const userId = BigInt(user.userId);

  const items = await prisma.merchant_recommendations.findMany({
    where: { source: NODE_SOURCE, node_code: code, is_deleted: 0 },
    orderBy: [{ epc: "desc" }],
    take: 500,
  });

  // 解析每行的平台代码（affiliate → LH/PM/...），解析不了的走名称匹配
  const recPlatform = (affiliate: string | null): string | null => {
    if (!affiliate) return null;
    const p = normalizePlatformCode(affiliate);
    return isValidPlatformCode(p) ? p : null;
  };

  const mids = items.filter((i) => i.mid && recPlatform(i.affiliate)).map((i) => i.mid as string);
  const names = items.map((i) => i.merchant_name);
  const mine = await prisma.user_merchants.findMany({
    where: {
      user_id: userId,
      is_deleted: 0,
      OR: [
        ...(mids.length > 0 ? [{ merchant_id: { in: mids } }] : []),
        ...(names.length > 0 ? [{ merchant_name: { in: names } }] : []),
      ],
    },
    select: {
      id: true, merchant_id: true, merchant_name: true, platform: true,
      status: true, category: true, violation_status: true, policy_status: true,
    },
  });
  // 平台+MID 精确键；名称键兜底。同键多行时优先保留已认领的那行
  const byPlatMid = new Map<string, (typeof mine)[0]>();
  const byName = new Map<string, (typeof mine)[0]>();
  const prefer = (prev: (typeof mine)[0] | undefined, cur: (typeof mine)[0]) =>
    !prev || (prev.status === "available" && cur.status !== "available") ? cur : prev;
  for (const m of mine) {
    const k = `${m.platform}:${m.merchant_id}`;
    byPlatMid.set(k, prefer(byPlatMid.get(k), m));
    const nk = m.merchant_name.toLowerCase();
    byName.set(nk, prefer(byName.get(nk), m));
  }

  const enriched = items.map((it) => {
    const plat = recPlatform(it.affiliate);
    const match =
      (plat && it.mid ? byPlatMid.get(`${plat}:${it.mid}`) : undefined) ||
      byName.get(it.merchant_name.toLowerCase());
    return {
      ...it,
      my_merchant_id: match ? match.id : null,
      my_status: match ? match.status : null, // null=未入库
      my_platform: match ? match.platform : null,
      my_category: match ? match.category : null,
      my_violation: match ? match.violation_status !== "normal" : false,
      my_policy_status: match ? match.policy_status : null,
    };
  });

  return apiSuccess(serializeData({ items: enriched, total: enriched.length }));
});
