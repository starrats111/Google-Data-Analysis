/**
 * D-180：联盟序号确认后的广告归属重排 + 链接键迁移
 *
 * 病因：账号删号重加/创建顺序错位，导致 account_index（联盟序号）与用户意图不符，
 * 广告名写 LH1 却被路由到别的连接；同时 connection_campaign_links 的链接键停留在旧连接 id
 * （常为已删除连接），pickCampaignAffiliateLink 取不到链接 → 换链补货 + 刷点击双双静默跳过。
 *
 * 用户在设置里确认序号后，本模块按「确认后的序号」把该 (user, platform) 的广告归属强制重排，
 * 并确保每条广告所属商家在「其目标连接」下有链接——缺失时从同账号的旧键（含已删连接键）迁移。
 *
 * 安全约束：
 *   - 只在同一 (user, platform) 内操作，绝不跨平台/跨用户。
 *   - 广告名序号段 → account_index 精确映射，映射不到的连接跳过并记录，绝不猜。
 *   - 链接键迁移仅当「来源键连接」与「目标连接」是同一账号（account_name+platform 一致）时才迁
 *     （含已删除来源连接：同账号追踪链接 token 有效，安全），避免把 A 账号链接迁给 B 账号造成串号。
 *   - 目标连接已有链接则不动。
 *   - dryRun=true 时只计算与记录，不写库。
 */

import prisma from "@/lib/prisma";
import { normalizePlatformCode } from "@/lib/constants";
import { parseCampaignNameFull } from "@/lib/campaign-merchant-link";

export interface ReassignChange {
  campaignId: string;
  campaignName: string;
  fromConnId: string | null;
  toConnId: string;
  accountIndex: number;
}

export interface LinkKeyMigration {
  merchantId: string;
  merchantName: string;
  fromKey: string;
  toKey: string;
  migrated: boolean;
  reason?: string;
}

export interface ReassignResult {
  platform: string;
  dryRun: boolean;
  campaignsReassigned: ReassignChange[];
  campaignsSkipped: { campaignId: string; campaignName: string; reason: string }[];
  linkMigrations: LinkKeyMigration[];
}

/**
 * 按确认后的联盟序号，重排某 (user, platform) 的广告归属并迁移链接键。
 * @param dryRun true=只算不写（上线前影子库验证用）
 */
export async function reassignByConfirmedIndex(
  userId: bigint,
  platformRaw: string,
  dryRun = false,
): Promise<ReassignResult> {
  const platform = normalizePlatformCode(platformRaw);
  const result: ReassignResult = {
    platform,
    dryRun,
    campaignsReassigned: [],
    campaignsSkipped: [],
    linkMigrations: [],
  };

  // 全部连接（含已删除）——判定「同账号」需要已删连接的账号信息
  const allConns = await prisma.platform_connections.findMany({
    where: { user_id: userId },
    select: { id: true, platform: true, account_name: true, account_index: true, is_deleted: true },
  });
  // connId → 账号标识（含已删）。账号名忽略大小写/首尾空白比较。
  const connAccount = new Map<string, { name: string; platform: string; deleted: boolean }>();
  for (const c of allConns) {
    connAccount.set(c.id.toString(), {
      name: (c.account_name || "").trim().toLowerCase(),
      platform: normalizePlatformCode(c.platform),
      deleted: c.is_deleted !== 0,
    });
  }
  // 序号 → connId（仅在用；确认后每序号唯一）
  const idxToConn = new Map<number, bigint>();
  for (const c of allConns) {
    if (c.is_deleted === 0 && normalizePlatformCode(c.platform) === platform && c.account_index) {
      idxToConn.set(c.account_index, c.id);
    }
  }
  if (idxToConn.size === 0) return result;

  // 该用户在投广告（有 gcid，且未下架——REMOVED 的历史广告不参与，避免为死广告迁链接/重排）
  const campaigns = await prisma.campaigns.findMany({
    where: {
      user_id: userId,
      is_deleted: 0,
      google_campaign_id: { not: null },
      status: { not: "removed" },
      google_status: { not: "REMOVED" },
    },
    select: { id: true, campaign_name: true, platform_connection_id: true, user_merchant_id: true },
  });

  // 每条广告 → 目标连接（按名字序号段）；同时收集「商家 → 需要有链接的目标连接集合」
  const merchantTargets = new Map<string, Set<string>>(); // merchantId -> set(toConnId)

  for (const c of campaigns) {
    const parsed = parseCampaignNameFull(c.campaign_name || "");
    if (!parsed || normalizePlatformCode(parsed.platform) !== platform) continue;

    const idx = parsed.accountIndex ?? 1; // 无序号段视为 1 号
    const toConn = idxToConn.get(idx);
    if (!toConn) {
      result.campaignsSkipped.push({
        campaignId: c.id.toString(),
        campaignName: c.campaign_name || "",
        reason: `无序号 ${platform}${idx} 的在用连接`,
      });
      continue;
    }
    const toConnStr = toConn.toString();

    // 记录该商家在该目标连接下需要有链接（无论广告归属是否变化）
    if (c.user_merchant_id && c.user_merchant_id > BigInt(0)) {
      const mid = c.user_merchant_id.toString();
      if (!merchantTargets.has(mid)) merchantTargets.set(mid, new Set());
      merchantTargets.get(mid)!.add(toConnStr);
    }

    // 广告归属重排（仅当与目标不同才改）
    const fromConn = c.platform_connection_id;
    if (fromConn && fromConn.toString() === toConnStr) continue;

    result.campaignsReassigned.push({
      campaignId: c.id.toString(),
      campaignName: c.campaign_name || "",
      fromConnId: fromConn ? fromConn.toString() : null,
      toConnId: toConnStr,
      accountIndex: idx,
    });

    if (!dryRun) {
      await prisma.campaigns.update({ where: { id: c.id }, data: { platform_connection_id: toConn } });
    }
  }

  // 链接键迁移：确保每个商家在其目标连接下取得到链接（pickCampaignAffiliateLink 口径）。
  // 「有链接」的两种合法形态：
  //   a) connection_campaign_links[toKey] 非空；
  //   b) 商家主连接 platform_connection_id === toKey 且主链接 campaign_link/tracking_link 非空。
  // 都不满足时才尝试从同账号旧连接迁移（per-conn 键 或 主连接指针），迁不了记人工。
  const merchantIds = [...merchantTargets.keys()].map((s) => BigInt(s));
  if (merchantIds.length > 0) {
    const merchants = await prisma.user_merchants.findMany({
      where: { id: { in: merchantIds }, user_id: userId, is_deleted: 0 },
      select: {
        id: true,
        merchant_name: true,
        connection_campaign_links: true,
        platform_connection_id: true,
        campaign_link: true,
        tracking_link: true,
      },
    });

    for (const m of merchants) {
      const targets = merchantTargets.get(m.id.toString());
      if (!targets) continue;

      const raw = m.connection_campaign_links;
      const links =
        raw && typeof raw === "object" && !Array.isArray(raw)
          ? { ...(raw as Record<string, string>) }
          : {};
      const primary = m.campaign_link?.trim() || m.tracking_link?.trim() || "";
      const primaryConnKey = m.platform_connection_id ? m.platform_connection_id.toString() : null;
      let linksMutated = false;

      for (const toKey of targets) {
        // a) per-conn 键已有链接
        if (typeof links[toKey] === "string" && links[toKey].trim()) continue;
        // b) 目标连接就是商家主连接且有主链接
        if (primaryConnKey === toKey && primary) continue;

        const toAccount = connAccount.get(toKey);

        // 迁移来源 1：同账号旧 per-conn 键
        let sourceKey: string | null = null;
        for (const [k, v] of Object.entries(links)) {
          if (k === toKey || typeof v !== "string" || !v.trim()) continue;
          const srcAccount = connAccount.get(k);
          if (
            toAccount &&
            srcAccount &&
            srcAccount.name === toAccount.name &&
            srcAccount.platform === toAccount.platform
          ) {
            sourceKey = k;
            break;
          }
        }
        if (sourceKey) {
          result.linkMigrations.push({
            merchantId: m.id.toString(),
            merchantName: m.merchant_name || "",
            fromKey: sourceKey,
            toKey,
            migrated: !dryRun,
          });
          links[toKey] = links[sourceKey];
          // 来源键属已删连接 → 搬走（清理残留）；属在用连接 → 复制保留（别的广告可能还在用它）
          if (connAccount.get(sourceKey)?.deleted) delete links[sourceKey];
          linksMutated = true;
          continue;
        }

        // 迁移来源 2：主链接挂在同账号的旧主连接（多为已删）上 → 把主链接复制进目标连接的 per-conn 键。
        // 只复制不改 platform_connection_id 指针，避免破坏仍依赖旧主连接取链的其他广告。
        if (primary && primaryConnKey && primaryConnKey !== toKey) {
          const srcAccount = connAccount.get(primaryConnKey);
          if (
            toAccount &&
            srcAccount &&
            srcAccount.name === toAccount.name &&
            srcAccount.platform === toAccount.platform
          ) {
            result.linkMigrations.push({
              merchantId: m.id.toString(),
              merchantName: m.merchant_name || "",
              fromKey: `primary:${primaryConnKey}`,
              toKey,
              migrated: !dryRun,
            });
            links[toKey] = primary;
            linksMutated = true;
            continue;
          }
        }

        result.linkMigrations.push({
          merchantId: m.id.toString(),
          merchantName: m.merchant_name || "",
          fromKey: "",
          toKey,
          migrated: false,
          reason: "无同账号旧链接可迁，需人工补链接",
        });
      }

      if (linksMutated && !dryRun) {
        await prisma.user_merchants.update({
          where: { id: m.id },
          data: { connection_campaign_links: links },
        });
      }
    }
  }

  console.log(
    `[AccountIndexReassign] user=${userId} platform=${platform} dryRun=${dryRun} ` +
      `reassigned=${result.campaignsReassigned.length} skipped=${result.campaignsSkipped.length} ` +
      `linkMigrated=${result.linkMigrations.filter((l) => l.migrated).length} ` +
      `linkNeedManual=${result.linkMigrations.filter((l) => !l.migrated).length}`,
  );

  return result;
}
