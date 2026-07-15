import { NextRequest } from "next/server";
import { getUserFromRequest } from "@/lib/auth";
import { apiSuccess, apiError, normalizePlatformCode } from "@/lib/constants";
import prisma from "@/lib/prisma";
import { reassignByConfirmedIndex } from "@/lib/account-index-reassign";

/**
 * D-180：联盟序号确认状态
 *
 * 副作用（幂等）：把「某平台仅 1 个在用连接」的连接自动补 account_index=1 且标记已确认，
 * 这类永不打扰用户。
 *
 * 返回 needsConfirm + 需要确认的平台（多连接且存在未确认者），带当前序号预填。
 */
export async function GET(req: NextRequest) {
  const user = getUserFromRequest(req);
  if (!user) return apiError("未授权", 401);
  const userId = BigInt(user.userId);

  const conns = await prisma.platform_connections.findMany({
    where: { user_id: userId, is_deleted: 0 },
    select: {
      id: true,
      platform: true,
      account_name: true,
      account_index: true,
      account_index_confirmed_at: true,
    },
    orderBy: [{ platform: "asc" }, { account_index: "asc" }, { created_at: "asc" }, { id: "asc" }],
  });

  // 按规范化平台分组
  const byPlatform = new Map<string, typeof conns>();
  for (const c of conns) {
    const p = normalizePlatformCode(c.platform);
    if (!byPlatform.has(p)) byPlatform.set(p, []);
    byPlatform.get(p)!.push(c);
  }

  // 单连接平台：自动 account_index=1 + 自动确认（幂等），并触发一次重排
  // （修复「删号重加后链接键滞留在已删连接」的场景，如 yz04 LH/mohawk 事故）
  const now = new Date();
  for (const [p, list] of byPlatform) {
    if (list.length !== 1) continue;
    const c = list[0];
    if (c.account_index !== 1 || !c.account_index_confirmed_at) {
      await prisma.platform_connections.update({
        where: { id: c.id },
        data: { account_index: 1, account_index_confirmed_at: now },
      });
      c.account_index = 1;
      c.account_index_confirmed_at = now;
      try {
        await reassignByConfirmedIndex(userId, p, false);
      } catch (e) {
        console.error(`[D-180 status] auto-confirm reassign failed user=${userId} platform=${p}:`, e);
      }
    }
  }

  // 需要确认的平台：多连接且存在未确认
  const platforms: {
    platform: string;
    connections: { id: string; account_name: string; account_index: number | null; confirmed: boolean }[];
  }[] = [];

  for (const [p, list] of byPlatform) {
    if (list.length < 2) continue;
    const hasUnconfirmed = list.some((c) => !c.account_index_confirmed_at);
    if (!hasUnconfirmed) continue;
    platforms.push({
      platform: p,
      connections: list.map((c) => ({
        id: c.id.toString(),
        account_name: c.account_name || "",
        account_index: c.account_index ?? null,
        confirmed: !!c.account_index_confirmed_at,
      })),
    });
  }

  return apiSuccess({ needsConfirm: platforms.length > 0, platforms });
}
