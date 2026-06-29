/**
 * 广告系列 ↔ 商家 强关联同步
 *
 * 核心规则（重写 2026-04-08）：
 *   商家状态 100% 由广告系列决定，两者强绑定，实时联动。
 *
 *   1. 有任意 ENABLED 广告系列 → 商家 "claimed"
 *   2. 所有广告系列均 PAUSED/REMOVED → 商家 "paused"
 *   3. 没有广告系列关联 → 商家保持原状态（available / 手动设定的状态）
 *
 *   同步入口唯一：syncMerchantStatusForUser(userId)
 *   此函数做两件事：
 *     A. 自动关联未绑定的广告系列到商家（通过命名规则匹配）
 *     B. 根据所有已关联广告系列的状态，强制更新商家状态
 */

import prisma from "@/lib/prisma";
import { normalizePlatformCode } from "@/lib/constants";

// ── 命名解析 ──

export interface ParsedCampaignName {
  platform: string;
  mid: string;
  merchantName: string;
  country: string;
}

/**
 * 从广告系列名中提取 平台+MID
 * 格式：序号-平台-商家名-国家-日期-MID （破折号或空格分隔）
 */
export function parseCampaignNameFull(name: string): ParsedCampaignName | null {
  if (!name) return null;
  const parts = name.split(/[-\s]+/);
  if (parts.length < 4) return null;

  const rawPlatform = parts[1]?.trim();
  const mid = parts[parts.length - 1]?.trim();
  if (!rawPlatform || !mid || !/^\d+$/.test(mid)) return null;

  const merchantName = parts[2]?.trim() || "";
  const country = parts.length >= 6 ? (parts[3]?.trim() || "US") : "US";

  return {
    platform: normalizePlatformCode(rawPlatform),
    mid,
    merchantName,
    country,
  };
}

// ── 自愈：确保广告系列关联到一个存活商家（孤儿/未匹配自动接回或新建）──

/**
 * 确保广告系列关联到一个存活的商家行，返回 merchantId（无法解析系列名时返回 null）。
 *
 * 用于「手动填链接」「Google 回拉链接」等自愈路径：
 *   - 已关联且商家存活 → 直接返回该 id
 *   - 未匹配(user_merchant_id<=0) 或 孤儿(指向已删商家) → 按系列名解析「平台-MID」，
 *     find-or-create user_merchants，并把系列 user_merchant_id 回填接回。
 */
export async function ensureCampaignMerchant(
  userId: bigint,
  campaign: { id: bigint; user_merchant_id: bigint | null; campaign_name: string | null; target_country: string | null },
): Promise<bigint | null> {
  if (campaign.user_merchant_id && campaign.user_merchant_id > BigInt(0)) {
    const m = await prisma.user_merchants.findFirst({
      where: { id: campaign.user_merchant_id, user_id: userId, is_deleted: 0 },
      select: { id: true },
    });
    if (m) return m.id;
  }

  const parsed = parseCampaignNameFull(campaign.campaign_name || "");
  if (!parsed) return null;

  const existing = await prisma.user_merchants.findFirst({
    where: { user_id: userId, platform: parsed.platform, merchant_id: parsed.mid, is_deleted: 0 },
    select: { id: true },
  });

  let merchantId: bigint;
  if (existing) {
    merchantId = existing.id;
  } else {
    const created = await prisma.user_merchants.create({
      data: {
        user_id: userId,
        platform: parsed.platform,
        merchant_id: parsed.mid,
        merchant_name: parsed.merchantName || parsed.mid,
        target_country: campaign.target_country || parsed.country || null,
        status: "claimed",
        claimed_at: new Date(),
        source: "platform",
      },
      select: { id: true },
    });
    merchantId = created.id;
  }

  if (campaign.user_merchant_id !== merchantId) {
    await prisma.campaigns.update({ where: { id: campaign.id }, data: { user_merchant_id: merchantId } });
  }
  return merchantId;
}

// ── 唯一入口：同步用户的商家状态 ──

/**
 * 同步用户所有商家状态（唯一入口）
 *
 * Step 1: 自动关联 user_merchant_id=0 的广告系列到对应商家
 * Step 2: 根据关联的广告系列状态，强制设置商家状态
 *
 * 调用时机：任何广告系列 google_status 变更之后
 */
export async function syncMerchantStatusForUser(userId: bigint): Promise<{
  linked: number;
  merchantsUpdated: number;
}> {
  const linked = await autoLinkCampaigns(userId);
  const merchantsUpdated = await forceUpdateMerchantStatus(userId);
  return { linked, merchantsUpdated };
}

// ── Step 1: 自动关联未绑定的广告系列 ──

async function autoLinkCampaigns(userId: bigint): Promise<number> {
  // 候选：所有真正投放(有 gcid)的在投广告系列。需要关联的有两类：
  //   1. user_merchant_id=0（从未关联）
  //   2. user_merchant_id>0 但指向的商家行已不存在/已软删（孤儿）——商家被同步误删后留下的，
  //      旧逻辑只处理第 1 类，导致孤儿广告永远接不回商家（换链接读不到追踪链接）。
  const candidates = await prisma.campaigns.findMany({
    where: {
      user_id: userId,
      is_deleted: 0,
      google_campaign_id: { not: null },
    },
    select: { id: true, campaign_name: true, user_merchant_id: true },
    take: 2000,
  });

  const refIds = candidates
    .map((c) => c.user_merchant_id)
    .filter((id): id is bigint => !!id && id > BigInt(0));
  const aliveRef = new Set(
    (refIds.length > 0
      ? await prisma.user_merchants.findMany({
          where: { id: { in: refIds }, user_id: userId, is_deleted: 0 },
          select: { id: true },
        })
      : []
    ).map((m) => m.id.toString()),
  );

  const unlinked = candidates.filter(
    (c) =>
      !c.user_merchant_id ||
      c.user_merchant_id <= BigInt(0) ||
      !aliveRef.has(c.user_merchant_id.toString()),
  );

  if (unlinked.length === 0) return 0;

  const userMerchants = await prisma.user_merchants.findMany({
    where: { user_id: userId, is_deleted: 0 },
    select: { id: true, platform: true, merchant_id: true },
  });
  const merchantIndex = new Map(
    userMerchants.map((m) => [
      `${normalizePlatformCode(m.platform)}_${m.merchant_id}`,
      m,
    ])
  );

  let linked = 0;
  const ops: Promise<unknown>[] = [];

  for (const campaign of unlinked) {
    const parsed = parseCampaignNameFull(campaign.campaign_name || "");
    if (!parsed) continue;

    const key = `${parsed.platform}_${parsed.mid}`;
    const merchant = merchantIndex.get(key);

    if (!merchant) {
      console.warn(
        `[MerchantAutoLink] 未找到商家: ${key}` +
        ` (campaign: "${campaign.campaign_name}")` +
        ` — 请在「商家库」中手动添加该商家后重新刷新`
      );
      continue;
    }

    ops.push(
      prisma.campaigns.update({
        where: { id: campaign.id },
        data: { user_merchant_id: merchant.id },
      })
    );
    linked++;

    // D-092：批量并发从 20 降到 5——sheet-sync 这类批量任务原先一次性 20 个并发 update 会
    // 几乎占满连接池，与并发广告生成抢连接，是 14:41 `pool timeout` 风暴的诱因之一。
    // 降到 5 既不拖慢同步（update 很快），又给生成留出连接余量。
    if (ops.length >= 5) {
      await Promise.all(ops.splice(0));
    }
  }

  if (ops.length > 0) await Promise.all(ops);

  if (linked > 0) {
    console.log(`[MerchantAutoLink] 关联 ${linked} 条广告系列`);
  }
  return linked;
}

// ── Step 2: 强制更新所有已关联商家的状态 ──

/**
 * 核心逻辑：遍历用户所有已关联广告系列，按商家汇总，强制设定状态：
 *   - 有任意 ENABLED → 商家 claimed
 *   - 全部 PAUSED/REMOVED → 商家 paused
 *   - 曾认领但所有广告系列已删除 → 商家 available（释放）
 *
 * 无条件覆盖，不管商家当前是什么状态。
 */
async function forceUpdateMerchantStatus(userId: bigint): Promise<number> {
  const campaigns = await prisma.campaigns.findMany({
    where: {
      user_id: userId,
      is_deleted: 0,
      user_merchant_id: { not: BigInt(0) },
    },
    select: { user_merchant_id: true, google_status: true },
  });

  // 按商家 ID 聚合：只要有一条 ENABLED，该商家就是 claimed
  const merchantTarget = new Map<string, "claimed" | "paused">();
  for (const c of campaigns) {
    const mid = String(c.user_merchant_id);
    if (c.google_status === "ENABLED") {
      merchantTarget.set(mid, "claimed");
    } else if (!merchantTarget.has(mid)) {
      merchantTarget.set(mid, "paused");
    }
  }

  const shouldClaim = [...merchantTarget.entries()]
    .filter(([, s]) => s === "claimed")
    .map(([id]) => BigInt(id));

  const shouldPause = [...merchantTarget.entries()]
    .filter(([, s]) => s === "paused")
    .map(([id]) => BigInt(id));

  let updated = 0;

  // 有 ENABLED 广告 → claimed
  if (shouldClaim.length > 0) {
    const r = await prisma.user_merchants.updateMany({
      where: {
        id: { in: shouldClaim },
        user_id: userId,
        is_deleted: 0,
        status: { not: "claimed" },
      },
      data: { status: "claimed", claimed_at: new Date() },
    });
    updated += r.count;
  }

  // 全部暂停/移除 → paused
  if (shouldPause.length > 0) {
    const r = await prisma.user_merchants.updateMany({
      where: {
        id: { in: shouldPause },
        user_id: userId,
        is_deleted: 0,
        status: { not: "paused" },
      },
      data: { status: "paused" },
    });
    updated += r.count;
  }

  // 释放：曾认领/暂停但已无活跃广告系列的商家 → available
  const hasActiveCampaign = new Set([...shouldClaim, ...shouldPause].map(String));
  const orphanedMerchants = await prisma.user_merchants.findMany({
    where: {
      user_id: userId,
      is_deleted: 0,
      status: { in: ["claimed", "paused"] },
    },
    select: { id: true },
  });

  const shouldRelease = orphanedMerchants
    .filter((m) => !hasActiveCampaign.has(String(m.id)))
    .map((m) => m.id);

  if (shouldRelease.length > 0) {
    const r = await prisma.user_merchants.updateMany({
      where: {
        id: { in: shouldRelease },
        user_id: userId,
        is_deleted: 0,
      },
      data: { status: "available", claimed_at: null },
    });
    updated += r.count;
    if (r.count > 0) {
      console.log(`[MerchantSync] 释放 ${r.count} 个无广告系列的商家回 available`);
    }
  }

  return updated;
}

// ── 兼容旧调用名（过渡期，最终所有调用点都应改为 syncMerchantStatusForUser） ──

export async function autoLinkAndCreateMerchants(userId: bigint): Promise<number> {
  const result = await syncMerchantStatusForUser(userId);
  return result.linked;
}

export async function syncMerchantStatusFromCampaigns(userId: bigint): Promise<number> {
  const result = await syncMerchantStatusForUser(userId);
  return result.merchantsUpdated;
}
