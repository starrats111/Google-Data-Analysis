import prisma from "@/lib/prisma";

/**
 * 「在跑」统一口径（D-195，推翻 D-183 的商家去重口径）：
 * 数的是**广告系列条数**，同一商家投多个国家算多条。
 * D-183 的过滤规则全部保留，只改计数单位。
 *
 * 计入条件：
 * - campaigns.is_deleted=0、google_status=ENABLED
 * - 有 google_campaign_id、有 customer_id
 * - mcc_id 属于该用户未删除的 MCC；**软删 MCC 一律不计**
 * - 不计入已移除/停用 CID（cancelled / is_available=D）下的系列
 */

/** 软删 MCC 下残留 ENABLED → 本地改判 PAUSED（与已移除 CID 自愈同级） */
export async function healEnabledUnderSoftDeletedMcc(
  userIds: bigint[],
): Promise<number> {
  if (userIds.length === 0) return 0;
  const deletedMccs = await prisma.google_mcc_accounts.findMany({
    where: { user_id: { in: userIds }, is_deleted: 1 },
    select: { id: true },
  });
  if (deletedMccs.length === 0) return 0;
  const deletedMccIds = deletedMccs.map((m) => m.id);
  try {
    const healed = await prisma.campaigns.updateMany({
      where: {
        user_id: { in: userIds },
        mcc_id: { in: deletedMccIds },
        is_deleted: 0,
        google_status: "ENABLED",
      },
      data: {
        google_status: "PAUSED",
        status: "paused",
        last_google_sync_at: new Date(),
      },
    });
    if (healed.count > 0) {
      console.log(
        `[ActiveRunning] 自愈：软删 MCC 下 ${healed.count} 条 ENABLED 系列改判 PAUSED（users=${userIds.length}）`,
      );
    }
    return healed.count;
  } catch (e) {
    console.warn(
      `[ActiveRunning] 软删 MCC 系列自愈失败（忽略）: ${e instanceof Error ? e.message : e}`,
    );
    return 0;
  }
}

export async function countActiveRunningCampaigns(
  userIds: bigint[],
): Promise<{ byUser: Map<string, number>; teamTotal: number }> {
  const byUser = new Map<string, number>();
  if (userIds.length === 0) return { byUser, teamTotal: 0 };

  // 先自愈，避免软删 MCC 残留 ENABLED 污染计数及其他依赖 ENABLED 的链路
  await healEnabledUnderSoftDeletedMcc(userIds);

  const allMccs = await prisma.google_mcc_accounts.findMany({
    where: { user_id: { in: userIds } },
    select: { id: true, user_id: true, is_deleted: true },
  });
  const mccIdsByUser = new Map<string, bigint[]>();
  const deletedMccIdsByUser = new Map<string, Set<string>>();
  for (const m of allMccs) {
    const uid = m.user_id.toString();
    if (Number(m.is_deleted) === 1) {
      if (!deletedMccIdsByUser.has(uid)) deletedMccIdsByUser.set(uid, new Set());
      deletedMccIdsByUser.get(uid)!.add(m.id.toString());
      continue;
    }
    if (!mccIdsByUser.has(uid)) mccIdsByUser.set(uid, []);
    mccIdsByUser.get(uid)!.push(m.id);
  }

  const allActiveMccIds = allMccs.filter((m) => Number(m.is_deleted) === 0).map((m) => m.id);
  const removedCidSet = new Set<string>();
  if (allActiveMccIds.length > 0) {
    const removedCidRows = await prisma.mcc_cid_accounts.findMany({
      where: {
        mcc_account_id: { in: allActiveMccIds },
        OR: [{ status: "cancelled" }, { is_available: "D" }],
      },
      select: { customer_id: true },
    });
    for (const r of removedCidRows) {
      if (r.customer_id) removedCidSet.add(r.customer_id.replace(/-/g, ""));
    }
  }

  // D-195：不再经 user_merchants 收窄。旧写法要求系列挂在 claimed/paused 商家上，
  // 会漏掉没挂商家的系列，而数据中心那侧把它们计入，两边规则本就不一致。
  const activeCampaigns = await prisma.campaigns.findMany({
    where: {
      user_id: { in: userIds },
      google_status: "ENABLED",
      customer_id: { not: null },
      is_deleted: 0,
      NOT: [{ google_campaign_id: null }, { google_campaign_id: "" }],
    },
    select: {
      user_id: true,
      customer_id: true,
      mcc_id: true,
    },
  });

  let teamTotal = 0;

  for (const c of activeCampaigns) {
    const uid = c.user_id.toString();
    // 软删 MCC 一律排除（含「用户已无任何活跃 MCC」时仍挂在软删 MCC 上的系列）
    if (c.mcc_id !== null) {
      const deleted = deletedMccIdsByUser.get(uid);
      if (deleted?.has(c.mcc_id.toString())) continue;
    }
    const userMccs = mccIdsByUser.get(uid) || [];
    // 有活跃 MCC 时只计这些 MCC；无活跃 MCC 时仅保留 mcc_id 为空的（不把软删 MCC 算进去）
    if (userMccs.length > 0) {
      if (c.mcc_id === null || !userMccs.some((id) => id === c.mcc_id)) continue;
    } else if (c.mcc_id !== null) {
      continue;
    }
    if (c.customer_id && removedCidSet.has(c.customer_id.replace(/-/g, ""))) continue;

    byUser.set(uid, (byUser.get(uid) || 0) + 1);
    teamTotal += 1;
  }

  return { byUser, teamTotal };
}

/**
 * 从已按 gcid 去重、已按数据中心可见范围过滤的系列列表统计在跑条数（D-195）。
 * 入参已经过滤过，这里只数 ENABLED。
 */
export function countEnabledCampaigns(
  campaigns: { google_status: string | null }[],
): number {
  let n = 0;
  for (const c of campaigns) {
    if (c.google_status === "ENABLED") n += 1;
  }
  return n;
}
