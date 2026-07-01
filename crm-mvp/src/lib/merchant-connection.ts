/**
 * D-004 共享工具：解析 user_merchant.connection_campaign_links
 *
 * - 把 JSON 形式 `{ "<platform_connection_id>": "<link>", ... }` 翻译为
 *   `[{ id, account_name, platform, link }, ...]`
 * - **跨用户安全**：只保留属于 current_user 的 platform_connection_id（F-15）
 *
 * 用法：先批量查 platform_connections 建 Map，再批量调用本函数
 */

import prisma from "@/lib/prisma";

export interface ConnectionAccount {
  id: string;
  account_name: string;
  platform: string;
  link: string;
}

/**
 * 批量预取一组 user_merchants 涉及的所有 platform_connections，建 Map
 *
 * @param merchants 每个含 connection_campaign_links（Json）
 * @param userId 当前用户 id（用于 user_id 过滤）
 * @returns connId(string) → { account_name, platform }
 */
export async function loadConnectionAccountMap(
  merchants: Array<{ connection_campaign_links: unknown }>,
  userId: bigint,
): Promise<Map<string, { account_name: string; platform: string }>> {
  const ids = new Set<string>();
  for (const m of merchants) {
    const links = m.connection_campaign_links;
    if (links && typeof links === "object" && !Array.isArray(links)) {
      for (const k of Object.keys(links as Record<string, string>)) {
        if (k) ids.add(k);
      }
    }
  }
  if (ids.size === 0) return new Map();

  const idBigInts: bigint[] = [];
  for (const s of ids) {
    try {
      idBigInts.push(BigInt(s));
    } catch {
      /* skip non-numeric keys */
    }
  }
  if (idBigInts.length === 0) return new Map();

  const conns = await prisma.platform_connections.findMany({
    where: {
      user_id: userId,
      is_deleted: 0,
      id: { in: idBigInts },
    },
    select: { id: true, account_name: true, platform: true },
  });
  return new Map(conns.map((c) => [c.id.toString(), { account_name: c.account_name, platform: c.platform }]));
}

/**
 * 把单个 merchant 的 connection_campaign_links 解析为 connection_accounts[]
 * 只保留 connAccountMap 内出现的 conn_id（即属于 current_user 的）
 */
/**
 * 账号感知地为「某条广告」挑选它该用的联盟追踪链接。
 *
 * 规则（核心：广告归属账号 campaignConnId 优先，绝不回退到别的号，避免串号）：
 *   1) campaignConnId 有值 且 connection_campaign_links 里有它的链接 → 用该链接（最精确）
 *   2) campaignConnId 有值 但仅等于商家主连接 → 用商家 campaign_link / tracking_link（主连接主链接）
 *   3) campaignConnId 有值 却找不到对应链接（该号没配链接）→ 返回 ''（宁可不刷/不换，也不刷到错号）
 *   4) campaignConnId 为空（存量未回填）→ 回退旧逻辑：tracking_link / campaign_link / 主连接链接
 *
 * @param campaignConnId 广告 campaigns.platform_connection_id（该广告归属的联盟账号）
 * @param merchant 商家行（需含 tracking_link / campaign_link / connection_campaign_links / platform_connection_id）
 */
export function pickCampaignAffiliateLink(
  campaignConnId: bigint | null | undefined,
  merchant: {
    tracking_link?: string | null;
    campaign_link?: string | null;
    connection_campaign_links?: unknown;
    platform_connection_id?: bigint | null;
  },
): string {
  const links =
    merchant.connection_campaign_links &&
    typeof merchant.connection_campaign_links === "object" &&
    !Array.isArray(merchant.connection_campaign_links)
      ? (merchant.connection_campaign_links as Record<string, string>)
      : null;
  const primary = (merchant.campaign_link?.trim() || merchant.tracking_link?.trim() || "");

  if (campaignConnId != null) {
    const key = campaignConnId.toString();
    const perConn = links && typeof links[key] === "string" ? links[key].trim() : "";
    if (perConn) return perConn;
    // 该账号在 connection_campaign_links 里没链接：只有当它就是商家主连接时，主链接才属于它
    if (merchant.platform_connection_id != null && merchant.platform_connection_id.toString() === key) {
      return primary;
    }
    // 归属账号明确、却没有它的链接 → 不返回别号链接，交由调用方跳过（不刷错号）
    return "";
  }

  // 存量未回填：保持旧行为
  if (primary) return primary;
  if (links) {
    for (const v of Object.values(links)) {
      if (typeof v === "string" && v.trim()) return v.trim();
    }
  }
  return "";
}

export function buildConnectionAccounts(
  linksRaw: unknown,
  connAccountMap: Map<string, { account_name: string; platform: string }>,
): ConnectionAccount[] {
  const out: ConnectionAccount[] = [];
  if (!linksRaw || typeof linksRaw !== "object" || Array.isArray(linksRaw)) return out;
  for (const [connIdStr, linkRaw] of Object.entries(linksRaw as Record<string, string>)) {
    const link = typeof linkRaw === "string" ? linkRaw : "";
    if (!link) continue;
    const info = connAccountMap.get(connIdStr);
    if (!info) continue;
    out.push({
      id: connIdStr,
      account_name: info.account_name || info.platform || connIdStr,
      platform: info.platform,
      link,
    });
  }
  return out;
}
