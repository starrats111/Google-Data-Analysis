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
