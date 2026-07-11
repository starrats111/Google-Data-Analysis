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
import { normalizePlatformCode, isValidPlatformCode, parsePlatformSegment } from "@/lib/constants";

// ── 命名解析 ──

export interface ParsedCampaignName {
  platform: string;
  /** D-168：平台段账号位次（LH2 → 2；LH → null=默认 1 号账号）。映射 platform_connections.account_index */
  accountIndex: number | null;
  mid: string;
  merchantName: string;
  country: string;
}

/**
 * 从广告系列名中提取 平台+MID
 * 格式：序号-平台-商家名-国家-日期-MID （破折号或空格分隔）
 *
 * 优先按破折号切分：商家名可含空格（如「zero water」「Hair Care」），若按空格一起切，
 * 国家段会错位（曾把 target_country 存成 "water"/"Care"，导致按国家取代理必失败）。
 * 国家取「倒数第 3 段」（…-国家-日期-MID）而非固定 parts[3]，商家名含破折号时同样成立；
 * 且必须是 2 位字母才采信，否则回退 US。
 */
export function parseCampaignNameFull(name: string): ParsedCampaignName | null {
  if (!name) return null;
  let parts = name.split(/-+/).map((p) => p.trim()).filter(Boolean);
  if (parts.length < 4) parts = name.split(/[-\s]+/).filter(Boolean);
  if (parts.length < 4) return null;

  const rawPlatform = parts[1]?.trim();
  const mid = parts[parts.length - 1]?.trim();
  if (!rawPlatform || !mid || !/^\d+$/.test(mid)) return null;

  let country = "US";
  let merchantName = parts[2]?.trim() || "";
  if (parts.length >= 6) {
    const candidate = parts[parts.length - 3]?.trim() || "";
    if (/^[A-Za-z]{2}$/.test(candidate)) country = candidate.toUpperCase();
    // 商家名 = 平台之后、国家段之前的所有段（含破折号商家名，如 coca-cola）
    merchantName = parts.slice(2, parts.length - 3).join("-").trim() || merchantName;
  }

  const seg = parsePlatformSegment(rawPlatform);
  return {
    platform: seg.code,
    accountIndex: seg.index,
    mid,
    merchantName,
    country,
  };
}

// ── D-167：平台段非法/缺失时的 MID 回退匹配 ──

/**
 * 系列名平台段非法（多为漏写平台段，如 K01-525america-US-0709-10831）时，
 * 按 MID 在候选商家中回退匹配。规则（07 拍板）：
 *   1. MID 唯一命中 → 采用；
 *   2. 多命中 → 用系列名第 2 段（漏写平台段时该段实际是商家名）与 merchant_name
 *      归一化比对决胜（如 aqara ↔ Aqara DTC）；
 *   3. 再决胜不了 → 优先 claimed 状态唯一者；
 *   4. 仍歧义 → 返回 null（调用方跳过+告警，绝不猜）。
 */
export function resolveMerchantByMidFallback(
  campaignName: string,
  mid: string,
  candidates: { id: bigint; merchant_id: string; merchant_name: string; status: string }[],
): bigint | null {
  const byMid = candidates.filter((m) => m.merchant_id === mid);
  if (byMid.length === 0) return null;
  if (byMid.length === 1) return byMid[0].id;

  // 漏写平台段时 parts[1] 是商家名段
  const nameSeg = (campaignName.split(/-+/)[1] || "").trim();
  const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");
  const seg = norm(nameSeg);
  if (seg) {
    const byName = byMid.filter((m) => {
      const mn = norm(m.merchant_name);
      return mn === seg || mn.startsWith(seg) || seg.startsWith(mn);
    });
    if (byName.length === 1) return byName[0].id;
  }

  const claimed = byMid.filter((m) => m.status === "claimed");
  if (claimed.length === 1) return claimed[0].id;

  return null;
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
  // 平台代码非法（多为漏写平台段）→ D-167 MID 回退匹配，命中才接回，绝不自建
  if (!isValidPlatformCode(parsed.platform)) {
    const candidates = await prisma.user_merchants.findMany({
      where: { user_id: userId, merchant_id: parsed.mid, is_deleted: 0 },
      select: { id: true, merchant_id: true, merchant_name: true, status: true },
    });
    const fallbackId = resolveMerchantByMidFallback(campaign.campaign_name || "", parsed.mid, candidates);
    if (!fallbackId) return null;
    if (campaign.user_merchant_id !== fallbackId) {
      await prisma.campaigns.update({ where: { id: campaign.id }, data: { user_merchant_id: fallbackId } });
    }
    return fallbackId;
  }

  const existing = await prisma.user_merchants.findFirst({
    where: { user_id: userId, platform: parsed.platform, merchant_id: parsed.mid, is_deleted: 0 },
    select: { id: true },
  });

  let merchantId: bigint;
  if (existing) {
    merchantId = existing.id;
  } else {
    // 自建商家时挂上该平台的联盟账号（默认取最早创建的连接）。否则 platform_connection_id 为空，
    // 「来路」解析链 商家→账号→发布网站 第一步即断，商家会一直落到「随机」来路（即便账号已绑网站）。
    const conn = await prisma.platform_connections.findFirst({
      where: { user_id: userId, platform: parsed.platform, is_deleted: 0 },
      select: { id: true },
      orderBy: { created_at: "asc" },
    });
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
        platform_connection_id: conn?.id ?? null,
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
  await backfillCampaignConnections(userId);
  const merchantsUpdated = await forceUpdateMerchantStatus(userId);
  return { linked, merchantsUpdated };
}

// ── D-168: 按系列名平台段序号回填广告系列的联盟账号 ──

/**
 * 系列名平台段带账号位次（07 规则：LH1=该平台第 1 个账号、LH2=第 2 个，删号补位），
 * 据此把 platform_connection_id 为空的系列自动归属到具体联盟连接：
 *   - LH2 → account_index=2 的 LH 存活连接；
 *   - LH（无序号）→ account_index=1（默认 1 号账号）；
 *   - 找不到对应位次的连接 → 保持 NULL 并告警，绝不猜。
 * 只填空值，绝不覆盖已有归属（保护手工回填/发布时写入的归属）。
 */
export async function backfillCampaignConnections(userId: bigint): Promise<number> {
  const candidates = await prisma.campaigns.findMany({
    where: {
      user_id: userId,
      is_deleted: 0,
      platform_connection_id: null,
      google_campaign_id: { not: null },
    },
    select: { id: true, campaign_name: true },
    take: 2000,
  });
  if (candidates.length === 0) return 0;

  const conns = await prisma.platform_connections.findMany({
    where: { user_id: userId, is_deleted: 0 },
    select: { id: true, platform: true, account_index: true },
    orderBy: [{ created_at: "asc" }, { id: "asc" }],
  });
  // platform → (账号位次 → connId)。account_index 未回填的老连接按创建顺序补最小空缺位次
  const byPlatform = new Map<string, Map<number, bigint>>();
  for (const c of conns) {
    const p = normalizePlatformCode(c.platform);
    if (!byPlatform.has(p)) byPlatform.set(p, new Map());
    const m = byPlatform.get(p)!;
    let idx = c.account_index ?? 0;
    if (!idx || m.has(idx)) {
      idx = 1;
      while (m.has(idx)) idx++;
    }
    m.set(idx, c.id);
  }

  let filled = 0;
  const ops: Promise<unknown>[] = [];
  for (const c of candidates) {
    const parsed = parseCampaignNameFull(c.campaign_name || "");
    if (!parsed || !isValidPlatformCode(parsed.platform)) continue;
    const idxMap = byPlatform.get(parsed.platform);
    if (!idxMap) continue;
    const idx = parsed.accountIndex ?? 1;
    const connId = idxMap.get(idx);
    if (!connId) {
      console.warn(
        `[ConnBackfill] D-168 无位次 ${parsed.platform}${idx} 的存活连接，跳过: "${c.campaign_name}"`,
      );
      continue;
    }
    ops.push(
      prisma.campaigns.update({
        where: { id: c.id },
        data: { platform_connection_id: connId },
      }),
    );
    filled++;
    if (ops.length >= 5) await Promise.all(ops.splice(0));
  }
  if (ops.length > 0) await Promise.all(ops);

  if (filled > 0) {
    console.log(`[ConnBackfill] D-168 按系列名账号位次回填 ${filled} 条系列的联盟连接`);
  }
  return filled;
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
    select: { id: true, campaign_name: true, user_merchant_id: true, target_country: true },
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
    select: { id: true, platform: true, merchant_id: true, merchant_name: true, status: true },
  });
  const merchantIndex = new Map<string, { id: bigint; platform: string; merchant_id: string }>(
    userMerchants.map((m) => [
      `${normalizePlatformCode(m.platform)}_${m.merchant_id}`,
      { id: m.id, platform: m.platform, merchant_id: m.merchant_id },
    ])
  );

  // 各平台默认联盟账号（最早创建的连接）：自建商家时挂上，使「来路」能取到账号绑定的发布网站。
  const userConns = await prisma.platform_connections.findMany({
    where: { user_id: userId, is_deleted: 0 },
    select: { id: true, platform: true },
    orderBy: { created_at: "asc" },
  });
  const connByPlatform = new Map<string, bigint>();
  for (const c of userConns) {
    const p = normalizePlatformCode(c.platform);
    if (!connByPlatform.has(p)) connByPlatform.set(p, c.id);
  }

  let linked = 0;
  let created = 0;
  const ops: Promise<unknown>[] = [];

  for (const campaign of unlinked) {
    const parsed = parseCampaignNameFull(campaign.campaign_name || "");
    if (!parsed) continue;

    const key = `${parsed.platform}_${parsed.mid}`;
    let merchant = merchantIndex.get(key);

    if (!merchant) {
      // 平台代码非法（多为漏写平台段，如 K01-525america-US-0709-10831）
      // → D-167 MID 回退匹配：唯一命中/商家名决胜/claimed 决胜，仍歧义才跳过告警，绝不自建
      if (!isValidPlatformCode(parsed.platform)) {
        const fallbackId = resolveMerchantByMidFallback(
          campaign.campaign_name || "", parsed.mid, userMerchants,
        );
        if (fallbackId) {
          ops.push(
            prisma.campaigns.update({
              where: { id: campaign.id },
              data: { user_merchant_id: fallbackId },
            })
          );
          linked++;
          console.log(
            `[MerchantAutoLink] D-167 MID回退关联: "${campaign.campaign_name}" → merchant ${fallbackId}`
          );
          if (ops.length >= 5) await Promise.all(ops.splice(0));
          continue;
        }
        console.warn(
          `[MerchantAutoLink] 跳过非法平台(MID回退亦无法唯一定位): ${key}` +
          ` (campaign: "${campaign.campaign_name}")`
        );
        continue;
      }
      // 平台 API 未返回该商家（未加入/无数据）→ 在 CRM 自建商家，避免广告系列长期「未匹配」。
      // 挂上该平台联盟账号（来路取账号网站）；status=claimed + 被在投系列引用 → 商家同步不会清理它。
      // 后续若平台同步返回该商家(joined) 或 Google 回拉拿到 suffix，会按 (平台,MID) 命中本行并补全链接。
      const newM = await prisma.user_merchants.create({
        data: {
          user_id: userId,
          platform: parsed.platform,
          merchant_id: parsed.mid,
          merchant_name: parsed.merchantName || parsed.mid,
          target_country: campaign.target_country || parsed.country || null,
          status: "claimed",
          claimed_at: new Date(),
          source: "platform",
          platform_connection_id: connByPlatform.get(parsed.platform) ?? null,
        },
        select: { id: true },
      });
      merchant = { id: newM.id, platform: parsed.platform, merchant_id: parsed.mid };
      merchantIndex.set(key, merchant);
      created++;
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
    console.log(`[MerchantAutoLink] 关联 ${linked} 条广告系列（其中自建商家 ${created} 个）`);
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
