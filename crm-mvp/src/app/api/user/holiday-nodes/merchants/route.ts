import { NextRequest } from "next/server";
import { withUser } from "@/lib/api-handler";
import { apiSuccess, apiError } from "@/lib/constants";
import { serializeData } from "@/lib/auth";
import prisma from "@/lib/prisma";
import { NODE_SOURCE } from "@/lib/holiday-nodes";

/**
 * D-278 节点推荐清单层（用户端）
 * GET ?code=black_friday → 该节点官方清单商家（EPC/佣金参考值），
 * 并与当前用户自己的商家库比对：在库标可认领/已认领，未入库如实标注（数据真实性规范：不造数据）。
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

  // 与"我的商家库"比对：优先按 mid ↔ merchant_id 精确匹配，无 mid 的行按名称匹配
  const mids = items.map((i) => i.mid).filter(Boolean) as string[];
  const names = items.filter((i) => !i.mid).map((i) => i.merchant_name);
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
  const byMid = new Map<string, (typeof mine)[0]>();
  const byName = new Map<string, (typeof mine)[0]>();
  for (const m of mine) {
    // 同 MID 多平台行时优先保留已认领的那行
    const prev = byMid.get(m.merchant_id);
    if (!prev || (prev.status === "available" && m.status !== "available")) byMid.set(m.merchant_id, m);
    const prevN = byName.get(m.merchant_name.toLowerCase());
    if (!prevN || (prevN.status === "available" && m.status !== "available")) byName.set(m.merchant_name.toLowerCase(), m);
  }

  const enriched = items.map((it) => {
    const match = (it.mid ? byMid.get(it.mid) : undefined) || byName.get(it.merchant_name.toLowerCase());
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
