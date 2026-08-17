import prisma from "@/lib/prisma";
import type { TokenPayload } from "@/lib/auth";

/**
 * D-241 广告系列只读访问域解析（仅供只读 GET 接口使用，写接口禁止调用）。
 *
 * 访问规则：
 * - 本人的系列 → 允许；
 * - 组长查本组组员的系列 → 允许（组长「组员数据看板」需要读组员的 AI 建议缓存与逐日明细，
 *   而 ai_recommendations / ads_daily_stats 都按归属人 user_id 存储，必须以归属人身份查询）。
 *
 * 返回 ownerId(string) -> 该归属人名下命中的 campaignIds 分组：
 * - 未命中的 id（不存在/已删除）静默丢弃，与原「只读缓存查不到就没有」语义一致；
 * - 只要有任何一个系列的归属人越出访问域，整体返回 null（调用方按 403 处理）。
 */
export async function resolveCampaignReadScopes(
  user: TokenPayload,
  campaignIds: bigint[],
): Promise<Map<string, bigint[]> | null> {
  const byOwner = new Map<string, bigint[]>();
  if (campaignIds.length === 0) return byOwner;

  const campaigns = await prisma.campaigns.findMany({
    where: { id: { in: campaignIds }, is_deleted: 0 },
    select: { id: true, user_id: true },
  });
  for (const c of campaigns) {
    const key = String(c.user_id);
    const list = byOwner.get(key);
    if (list) list.push(c.id);
    else byOwner.set(key, [c.id]);
  }

  const foreignOwners = [...byOwner.keys()].filter((k) => k !== user.userId);
  if (foreignOwners.length > 0) {
    if (user.role !== "leader" || !user.teamId) return null;
    const members = await prisma.users.findMany({
      where: {
        id: { in: foreignOwners.map((k) => BigInt(k)) },
        team_id: BigInt(user.teamId),
        is_deleted: 0,
      },
      select: { id: true },
    });
    if (members.length !== foreignOwners.length) return null;
  }
  return byOwner;
}
