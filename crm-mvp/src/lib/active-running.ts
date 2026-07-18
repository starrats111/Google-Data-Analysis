import prisma from "@/lib/prisma";

/**
 * 「在跑广告数 / 在跑商家」统一口径（D-183）：
 * 有 ENABLED 广告系列的商家去重计数；与数据中心可见范围一致。
 *
 * 计入条件：
 * - campaigns.is_deleted=0、google_status=ENABLED
 * - 有 google_campaign_id、有 customer_id
 * - 挂在 user_merchants（claimed/paused）上
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

export async function countActiveRunningMerchants(
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

  const activeUms = await prisma.user_merchants.findMany({
    where: {
      user_id: { in: userIds },
      is_deleted: 0,
      status: { in: ["claimed", "paused"] },
    },
    select: { id: true, user_id: true, merchant_id: true, platform: true },
  });
  if (activeUms.length === 0) return { byUser, teamTotal: 0 };

  const umToMerchant = new Map(
    activeUms.map((um) => [um.id.toString(), `${um.merchant_id}:${um.platform}`]),
  );
  const umIds = activeUms.map((um) => um.id);

  const activeCampaigns = await prisma.campaigns.findMany({
    where: {
      user_merchant_id: { in: umIds },
      google_status: "ENABLED",
      customer_id: { not: null },
      is_deleted: 0,
      NOT: [{ google_campaign_id: null }, { google_campaign_id: "" }],
    },
    select: {
      user_id: true,
      user_merchant_id: true,
      customer_id: true,
      mcc_id: true,
    },
  });

  const userMerchantSets = new Map<string, Set<string>>();
  const teamMerchantSet = new Set<string>();

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

    const merchantKey = umToMerchant.get(c.user_merchant_id.toString());
    if (!merchantKey) continue;

    if (!userMerchantSets.has(uid)) userMerchantSets.set(uid, new Set());
    userMerchantSets.get(uid)!.add(merchantKey);
    teamMerchantSet.add(merchantKey);
  }

  for (const [uid, merchantSet] of userMerchantSets) {
    byUser.set(uid, merchantSet.size);
  }
  return { byUser, teamTotal: teamMerchantSet.size };
}

/**
 * 从已去重、已按数据中心可见范围过滤的 ENABLED 系列列表，
 * 统计有启用系列的商家去重数（无 user_merchant_id 的系列各计 1）。
 */
export function countEnabledMerchantsFromCampaigns(
  campaigns: { google_status: string | null; user_merchant_id: bigint | null }[],
): number {
  const keys = new Set<string>();
  let orphan = 0;
  for (const c of campaigns) {
    if (c.google_status !== "ENABLED") continue;
    if (c.user_merchant_id == null) {
      orphan += 1;
      continue;
    }
    keys.add(c.user_merchant_id.toString());
  }
  return keys.size + orphan;
}
