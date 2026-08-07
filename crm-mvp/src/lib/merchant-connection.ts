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
  /** D-199：账号位次，前端据此显示 `PM8 · weilixia`（account_name 同平台常同名，单靠它认不出号） */
  account_index: number | null;
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
): Promise<Map<string, { account_name: string; account_index: number | null; platform: string }>> {
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
    select: { id: true, account_name: true, account_index: true, platform: true },
  });
  return new Map(
    conns.map((c) => [
      c.id.toString(),
      { account_name: c.account_name, account_index: c.account_index ?? null, platform: c.platform },
    ]),
  );
}

/**
 * D-192 账号等价表：connId → 指向「同一个联盟账号」的其他 connId 列表。
 *
 * 同一物理账号被重复录成多条连接时（api_key 完全相同），订单/点击回传会落到其中一条，
 * 而商家链接可能存在另一条名下，`pickCampaignAffiliateLink` 会误判为串号而拒绝取链接
 * ——wj04 的 PM1(conn13) 与 PM8(conn217) 就是同一个 Partnermatic 账号，导致 garrett wade
 * 有单却一次点击都刷不出去。入口去重已于 c7f780e9 上线，本表用于消化其之前的存量残留。
 * 该例已在 D-199 由合并连接根治（conn217 的行并入 conn13 并退役），本表仍保留：
 * 等价关系是按 api_key 动态算的，其他用户的存量重复连接还需要它兜住。
 *
 * 刻意**包含已删连接**：连接删掉重加后，链接键仍留在旧 conn 上，只要凭据相同就是同一个号。
 */
export type ConnectionAliasMap = Map<string, string[]>;

// 补货（stock-producer）是每几分钟遍历全部在投系列的热路径，逐条查连接会在低配生产机上放大成
// 上千次查询。等价关系只取决于连接凭据，变动极少，短 TTL memo 足够且不会让新配的链接延迟生效。
const ALIAS_CACHE_TTL_MS = 60_000;
const aliasCache = new Map<string, { at: number; map: ConnectionAliasMap }>();

export async function loadConnectionAliasMap(userId: bigint): Promise<ConnectionAliasMap> {
  const cacheKey = userId.toString();
  const cached = aliasCache.get(cacheKey);
  if (cached && Date.now() - cached.at < ALIAS_CACHE_TTL_MS) return cached.map;

  const conns = await prisma.platform_connections.findMany({
    where: { user_id: userId },
    select: { id: true, platform: true, api_key: true },
  });

  const byCredential = new Map<string, string[]>();
  for (const c of conns) {
    const key = (c.api_key ?? "").trim();
    if (!key) continue;
    const group = `${c.platform}\u0000${key}`;
    const ids = byCredential.get(group);
    if (ids) ids.push(c.id.toString());
    else byCredential.set(group, [c.id.toString()]);
  }

  const aliasMap: ConnectionAliasMap = new Map();
  for (const ids of byCredential.values()) {
    if (ids.length < 2) continue;
    for (const id of ids) aliasMap.set(id, ids.filter((other) => other !== id));
  }
  aliasCache.set(cacheKey, { at: Date.now(), map: aliasMap });
  return aliasMap;
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
 *   3) campaignConnId 有值 但同一联盟账号的其他连接（api_key 相同）有链接 → 用该链接（D-192，同号不算串号）
 *   4) campaignConnId 有值 却找不到对应链接（该号没配链接）→ 返回 ''（宁可不刷/不换，也不刷到错号）
 *   5) campaignConnId 为空（存量未回填）→ 回退旧逻辑：tracking_link / campaign_link / 主连接链接
 *
 * @param campaignConnId 广告 campaigns.platform_connection_id（该广告归属的联盟账号）
 * @param merchant 商家行（需含 tracking_link / campaign_link / connection_campaign_links / platform_connection_id）
 * @param aliasMap loadConnectionAliasMap 的产物；不传则退化为改动前行为
 */
export function pickCampaignAffiliateLink(
  campaignConnId: bigint | null | undefined,
  merchant: {
    tracking_link?: string | null;
    campaign_link?: string | null;
    connection_campaign_links?: unknown;
    platform_connection_id?: bigint | null;
  },
  aliasMap?: ConnectionAliasMap,
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
    // D-192：同一联盟账号被重复录入成多条连接（api_key 相同）时，另一条名下的链接同样属于本号
    for (const alias of aliasMap?.get(key) ?? []) {
      const aliasLink = links && typeof links[alias] === "string" ? links[alias].trim() : "";
      if (aliasLink) return aliasLink;
      if (primary && merchant.platform_connection_id?.toString() === alias) return primary;
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

/**
 * D-224 为「巡航校验」挑链接：只读地跟一次跳转链，验可达性 + 认上级联盟。
 *
 * 与 `pickCampaignAffiliateLink` 的差别只在最后一步——那个函数服务于补货/刷点击，
 * 归属账号没链接时必须返回 '' 以免刷错号；巡航不写库存、不刷点击，且同一商家各账号链接
 * 的上级联盟本就一致，用哪条都得出同样结论，所以这里兜底到任意账号槽位。
 *
 * 不兜底会误报：`updateLink` 按广告归属账号写槽位，归属 ≠ 商家主连接时链接不进主链接字段，
 * 巡航侧若只认商家主连接就取不到，把刚存的可用链接判成「无可用联盟链接」。
 *
 * @param campaignConnId 广告归属账号；批量场景（一个商家多条广告）不确定时传 null
 */
export function pickCruiseAffiliateLink(
  merchant: {
    tracking_link?: string | null;
    campaign_link?: string | null;
    connection_campaign_links?: unknown;
    platform_connection_id?: bigint | null;
  },
  campaignConnId?: bigint | null,
  aliasMap?: ConnectionAliasMap,
): string {
  if (campaignConnId != null) {
    const byCampaign = pickCampaignAffiliateLink(campaignConnId, merchant, aliasMap);
    if (byCampaign) return byCampaign;
  }
  // 商家主连接槽位 → 主链接（改动前的既有优先级，保持不变）
  const links =
    merchant.connection_campaign_links &&
    typeof merchant.connection_campaign_links === "object" &&
    !Array.isArray(merchant.connection_campaign_links)
      ? (merchant.connection_campaign_links as Record<string, string>)
      : null;
  if (links && merchant.platform_connection_id != null) {
    const v = String(links[String(merchant.platform_connection_id)] || "").trim();
    if (v) return v;
  }
  const camp = String(merchant.campaign_link || "").trim();
  if (camp) return camp;
  const tracking = String(merchant.tracking_link || "").trim();
  if (tracking) return tracking;
  // 兜底：链接只存在别的账号槽位里（归属 ≠ 主连接时的常态）
  if (links) {
    for (const v of Object.values(links)) {
      if (typeof v === "string" && v.trim()) return v.trim();
    }
  }
  return "";
}

export function buildConnectionAccounts(
  linksRaw: unknown,
  connAccountMap: Map<string, { account_name: string; account_index: number | null; platform: string }>,
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
      account_index: info.account_index,
      platform: info.platform,
      link,
    });
  }
  return out;
}
