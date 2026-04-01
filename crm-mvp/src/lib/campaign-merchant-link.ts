/**
 * 广告系列与商家的关联与状态同步
 *
 * 商家状态说明：
 *   "available" — 商家在平台商家库中，尚未被任何用户认领
 *   "claimed"   — 商家已被认领，且有 ENABLED 广告系列在投放
 *   "paused"    — 商家已被认领，但关联的所有广告系列均为 PAUSED/REMOVED
 *
 * 核心规则（07 确认，2026-04-01）：
 * 1. 只要广告系列存在该商家，该商家就是「我的商家」，不应释放回「查找商家」
 * 2. 商家状态跟随广告系列：ENABLED → "claimed"，全部 PAUSED → "paused"
 * 3. 系统不自动创建商家——员工手动建广告时，商家应已在系统中，找不到则仅记录日志待人工处理
 */

import prisma from "@/lib/prisma";
import { normalizePlatformCode } from "@/lib/constants";

export interface ParsedCampaignName {
  platform: string;
  mid: string;
  merchantName: string;
  country: string;
}

/**
 * 从广告系列名中完整提取命名信息
 * 支持两种格式：
 *   破折号: 003-RW-deltachildren-US-0126-117904
 *   空格:   011 CG cellFilter JS 0320 8000389
 *
 * 结构：序号-平台-商家名-国家/地区-日期(MMDD)-MID
 * MID 始终是末尾的纯数字段
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

/**
 * 为 user_merchant_id = 0 的广告系列匹配已有商家并关联
 *
 * 逻辑：
 * 1. 找出所有 user_merchant_id = 0 的广告系列
 * 2. 解析广告系列名称，获取 platform + MID
 * 3. 在 user_merchants 中查找匹配商家
 *    - 找到 → 关联，并根据广告系列 google_status 设置商家状态：
 *              ENABLED → "claimed"，其余 → "paused"
 *    - 未找到 → 记录警告日志，跳过（不自动创建商家）
 *
 * 返回成功关联的广告系列条数。
 */
export async function autoLinkAndCreateMerchants(userId: bigint): Promise<number> {
  const unlinked = await prisma.campaigns.findMany({
    where: {
      user_id: userId,
      user_merchant_id: BigInt(0),
      is_deleted: 0,
      google_campaign_id: { not: null },
    },
    select: { id: true, campaign_name: true, google_status: true },
    take: 500,
  });

  if (unlinked.length === 0) return 0;

  // 预加载当前用户所有商家，构建 platform_mid → merchant 索引
  const userMerchants = await prisma.user_merchants.findMany({
    where: { user_id: userId, is_deleted: 0 },
    select: { id: true, platform: true, merchant_id: true, status: true },
  });
  const merchantIndex = new Map(
    userMerchants.map((m) => [
      `${normalizePlatformCode(m.platform)}_${m.merchant_id}`,
      m,
    ])
  );

  let linked = 0;
  const pendingOps: Promise<unknown>[] = [];

  const flush = async () => {
    if (pendingOps.length >= 20) {
      await Promise.all(pendingOps.splice(0));
    }
  };

  for (const campaign of unlinked) {
    const parsed = parseCampaignNameFull(campaign.campaign_name || "");
    if (!parsed) continue;

    const key = `${parsed.platform}_${parsed.mid}`;
    const merchant = merchantIndex.get(key);

    if (!merchant) {
      // 商家在系统中不存在，不自动创建，记录日志等待人工在「商家库」中添加
      console.warn(
        `[MerchantAutoLink] 未找到商家: ${key}` +
        ` (campaign: "${campaign.campaign_name}")` +
        ` — 请在「商家库」中手动添加该商家后重新刷新`
      );
      continue;
    }

    // 关联广告系列到商家
    pendingOps.push(
      prisma.campaigns.update({
        where: { id: campaign.id },
        data: { user_merchant_id: merchant.id },
      })
    );

    // 商家状态跟随广告系列：ENABLED → "claimed"，其余 → "paused"
    const targetStatus = campaign.google_status === "ENABLED" ? "claimed" : "paused";
    if (merchant.status !== targetStatus && merchant.status !== "claimed") {
      // 规则：只升不降（available → claimed/paused，paused → claimed，不把 claimed 降为 paused）
      // claimed → paused 的降级由 syncMerchantStatusFromCampaigns 统一处理
      pendingOps.push(
        prisma.user_merchants.update({
          where: { id: merchant.id },
          data: {
            status: targetStatus,
            ...(targetStatus === "claimed" ? { claimed_at: new Date() } : {}),
          },
        })
      );
      merchant.status = targetStatus;
    } else if (targetStatus === "claimed" && merchant.status !== "claimed") {
      pendingOps.push(
        prisma.user_merchants.update({
          where: { id: merchant.id },
          data: { status: "claimed", claimed_at: new Date() },
        })
      );
      merchant.status = "claimed";
    }

    linked++;
    await flush();
  }

  if (pendingOps.length > 0) await Promise.all(pendingOps);

  if (linked > 0) {
    console.log(`[MerchantAutoLink] 完成：关联 ${linked} 条广告系列`);
  }
  return linked;
}

/**
 * 已关联商家的持续状态同步（状态跟随广告系列）：
 *
 * - 有任意 ENABLED 广告系列 → 商家状态 = "claimed"
 * - 所有关联广告系列均为 PAUSED/REMOVED → 商家状态 = "paused"
 *
 * 注：两种状态都属于「我的商家」，均不会降回 "available"。
 *
 * 返回被更新的商家条数。
 */
export async function syncMerchantStatusFromCampaigns(userId: bigint): Promise<number> {
  // 拉取所有有关联广告的商家及其广告状态
  const linkedCampaigns = await prisma.campaigns.findMany({
    where: {
      user_id: userId,
      is_deleted: 0,
      user_merchant_id: { not: BigInt(0) },
      google_campaign_id: { not: null },
    },
    select: { user_merchant_id: true, google_status: true },
  });

  if (linkedCampaigns.length === 0) return 0;

  // 对每个商家判断：是否有任意 ENABLED 广告
  const merchantHasEnabled = new Map<string, boolean>();
  for (const c of linkedCampaigns) {
    const id = String(c.user_merchant_id);
    if (c.google_status === "ENABLED") {
      merchantHasEnabled.set(id, true);
    } else if (!merchantHasEnabled.has(id)) {
      merchantHasEnabled.set(id, false);
    }
  }

  const enabledMerchantIds = [...merchantHasEnabled.entries()]
    .filter(([, hasEnabled]) => hasEnabled)
    .map(([id]) => BigInt(id));

  const pausedMerchantIds = [...merchantHasEnabled.entries()]
    .filter(([, hasEnabled]) => !hasEnabled)
    .map(([id]) => BigInt(id));

  let updated = 0;

  // 有 ENABLED 广告 → 升为 "claimed"
  if (enabledMerchantIds.length > 0) {
    const r = await prisma.user_merchants.updateMany({
      where: {
        id: { in: enabledMerchantIds },
        user_id: userId,
        is_deleted: 0,
        status: { not: "claimed" },
      },
      data: { status: "claimed", claimed_at: new Date() },
    });
    updated += r.count;
  }

  // 全部 PAUSED/REMOVED → 降为 "paused"（不释放回 "available"）
  if (pausedMerchantIds.length > 0) {
    const r = await prisma.user_merchants.updateMany({
      where: {
        id: { in: pausedMerchantIds },
        user_id: userId,
        is_deleted: 0,
        // 不更新 "available"（未关联的商家不受影响），只调整已认领的
        status: { in: ["claimed"] },
      },
      data: { status: "paused" },
    });
    updated += r.count;
  }

  return updated;
}
