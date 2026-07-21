/**
 * BUG 修复扫描：广告「归属联盟账号」取不到该商家链接（哑广告，刷点击/换链静默跳过），
 * 但同平台同用户的**另一个账号**其实有该商家链接 → 可安全改归属救活。
 *
 * 判定「某账号 connId 对某商家有链接」的口径 = pickCampaignAffiliateLink 同款：
 *   a) connection_campaign_links[connId] 非空；或
 *   b) 商家主连接 platform_connection_id === connId 且主链接(campaign_link/tracking_link)非空。
 *
 * 目标账号挑选（保守，绝不串号/绝不臆造链接）：
 *   - 只在「同一 user + 同一 platform」范围内找有链接的在用连接；
 *   - 优先商家主连接（若它有链接），否则取 connection_campaign_links 里有链接的最小 account_index 的在用连接；
 *   - 找不到任何有链接的同平台账号 → 不动，记入「需人工补链接」。
 *
 * 默认 dry-run（不写库）。加 --apply 才真正 UPDATE campaigns.platform_connection_id。
 *
 * 用法（隧道连生产库）：
 *   npx tsx scripts/fix-orphan-conn-attribution.ts            # dry-run
 *   npx tsx scripts/fix-orphan-conn-attribution.ts --apply    # 执行
 */
import { loadEnvFromProjectRoot } from "./load-env-from-dotenv-file";
loadEnvFromProjectRoot();

const APPLY = process.argv.includes("--apply");

type LinksObj = Record<string, string> | null;

function asLinks(raw: unknown): LinksObj {
  if (raw && typeof raw === "object" && !Array.isArray(raw)) return raw as Record<string, string>;
  return null;
}

/** 账号 connId 对该商家是否有链接（pickCampaignAffiliateLink 口径） */
function connHasLink(
  connId: string,
  merchant: { connection_campaign_links: unknown; platform_connection_id: bigint | null; campaign_link: string | null; tracking_link: string | null },
): boolean {
  const links = asLinks(merchant.connection_campaign_links);
  const perConn = links && typeof links[connId] === "string" ? links[connId].trim() : "";
  if (perConn) return true;
  const primary = (merchant.campaign_link?.trim() || merchant.tracking_link?.trim() || "");
  if (primary && merchant.platform_connection_id != null && merchant.platform_connection_id.toString() === connId) return true;
  return false;
}

interface Fix { campaignId: string; userId: string; name: string; fromConn: string; toConn: string; merchant: string; sameAccount: boolean; }
interface Manual { campaignId: string; userId: string; name: string; fromConn: string; merchant: string; reason: string; }

async function main() {
  const { prisma } = await import("@/lib/prisma");
  const { normalizePlatformCode } = await import("@/lib/constants");

  console.log(`\n=== 扫描哑广告（归属账号无商家链接、可改归属救活） ${APPLY ? "【APPLY 写库】" : "【DRY-RUN 只读】"} ===\n`);

  const fixes: Fix[] = [];
  const manual: Manual[] = [];
  const usernameCache = new Map<string, string>();

  // 逐用户处理，避免全库大查询把低配生产机 + SSH 隧道拖垮（ECONNRESET）
  // 排除「只记录数据、禁用换链/刷点击」的用户（jy 交垟队，link_exchange_disabled=1）——其广告本就不刷点击，哑属正常。
  const users = await prisma.users.findMany({ where: { is_deleted: 0, link_exchange_disabled: { not: 1 } }, select: { id: true, username: true }, orderBy: { id: "asc" } });
  for (const u of users) usernameCache.set(u.id.toString(), u.username ?? u.id.toString());

  for (const u of users) {
    const userId = u.id;

    // 该用户已绑定归属、绑真实商家的在投广告
    const campaigns = await prisma.campaigns.findMany({
      where: {
        user_id: userId,
        is_deleted: 0,
        google_campaign_id: { not: null },
        status: { not: "removed" },
        google_status: { not: "REMOVED" },
        platform_connection_id: { not: null },
        user_merchant_id: { not: BigInt(0) },
      },
      select: { id: true, campaign_name: true, platform_connection_id: true, user_merchant_id: true },
    });
    if (campaigns.length === 0) continue;

    // 该用户在用连接
    const conns = await prisma.platform_connections.findMany({
      where: { user_id: userId, is_deleted: 0 },
      select: { id: true, platform: true, account_index: true, account_name: true },
    });
    const connById = new Map<string, { platform: string; account_index: number | null; account_name: string }>();
    const connsByPlatform = new Map<string, { id: string; account_index: number | null }[]>();
    for (const c of conns) {
      const p = normalizePlatformCode(c.platform);
      connById.set(c.id.toString(), { platform: p, account_index: c.account_index, account_name: (c.account_name || "").trim().toLowerCase() });
      if (!connsByPlatform.has(p)) connsByPlatform.set(p, []);
      connsByPlatform.get(p)!.push({ id: c.id.toString(), account_index: c.account_index });
    }

    // 只取该用户这些广告涉及到的商家（去重、分块），字段最小化
    const merchantIds = Array.from(new Set(campaigns.map((c) => c.user_merchant_id!.toString()))).map((s) => BigInt(s));
    const merchants = new Map<string, any>();
    const CHUNK = 200;
    for (let i = 0; i < merchantIds.length; i += CHUNK) {
      const rows = await prisma.user_merchants.findMany({
        where: { id: { in: merchantIds.slice(i, i + CHUNK) } },
        select: { id: true, merchant_name: true, merchant_id: true, platform: true, platform_connection_id: true, connection_campaign_links: true, campaign_link: true, tracking_link: true, is_deleted: true },
      });
      for (const r of rows) merchants.set(r.id.toString(), r);
    }

    for (const c of campaigns) {
      const connId = c.platform_connection_id!.toString();
      const m = merchants.get(c.user_merchant_id!.toString());
      if (!m || m.is_deleted !== 0) continue;
      if (connHasLink(connId, m)) continue;

      const platform = normalizePlatformCode(m.platform || "");
      const candidates = connsByPlatform.get(platform) || [];
      const withLink = candidates
        .filter((cand) => cand.id !== connId && connHasLink(cand.id, m))
        .sort((a, b) => {
          const aPrimary = m.platform_connection_id != null && m.platform_connection_id.toString() === a.id ? 0 : 1;
          const bPrimary = m.platform_connection_id != null && m.platform_connection_id.toString() === b.id ? 0 : 1;
          if (aPrimary !== bPrimary) return aPrimary - bPrimary;
          return (a.account_index ?? 999) - (b.account_index ?? 999);
        });

      if (withLink.length === 0) {
        manual.push({ campaignId: c.id.toString(), userId: userId.toString(), name: c.campaign_name || "", fromConn: connId, merchant: `${m.merchant_name}(${m.merchant_id})`, reason: "同平台无任何账号有该商家链接" });
        continue;
      }
      // 标注：来源账号与目标账号是否「同账号名」（同一联盟账号的多连接，改归属最安全、绝不串号）
      const fromName = connById.get(connId)?.account_name ?? "";
      const toName = connById.get(withLink[0].id)?.account_name ?? "";
      const sameAccount = !!fromName && fromName === toName;
      fixes.push({ campaignId: c.id.toString(), userId: userId.toString(), name: c.campaign_name || "", fromConn: connId, toConn: withLink[0].id, merchant: `${m.merchant_name}(${m.merchant_id})`, sameAccount });
    }
  }

  const uname = (uid: string) => usernameCache.get(uid) ?? uid;

  // 只自动改「同账号名」的归属（同一联盟账号的多连接，绝不串号）；跨不同账号名的单列出来人工确认
  const safeFixes = fixes.filter((f) => f.sameAccount);
  const crossFixes = fixes.filter((f) => !f.sameAccount);

  // 汇总：按用户分组打印（可自动修复=同账号）
  const byUser = new Map<string, Fix[]>();
  for (const f of safeFixes) {
    if (!byUser.has(f.userId)) byUser.set(f.userId, []);
    byUser.get(f.userId)!.push(f);
  }
  console.log(`可自动改归属救活(同账号，安全): ${safeFixes.length} 条；跨不同账号名需人工确认: ${crossFixes.length} 条；同平台无任何账号有链接(需补链接): ${manual.length} 条\n`);
  console.log("─── ① 可自动修复（同账号名，按用户）───");
  for (const [uid, list] of [...byUser.entries()].sort((a, b) => b[1].length - a[1].length)) {
    console.log(`\n【${uname(uid)} (uid=${uid})】${list.length} 条:`);
    for (const f of list) {
      console.log(`  camp=${f.campaignId} ${f.name} | 归属 conn${f.fromConn} → conn${f.toConn} | ${f.merchant}`);
    }
  }

  if (crossFixes.length > 0) {
    console.log("\n─── ② 跨不同账号名，需人工确认（不自动改，避免串号）───");
    for (const f of crossFixes) {
      console.log(`  【${uname(f.userId)}】camp=${f.campaignId} ${f.name} | 归属 conn${f.fromConn} → conn${f.toConn}(异账号) | ${f.merchant}`);
    }
  }

  if (manual.length > 0) {
    console.log("\n─── ③ 同平台无任何账号有链接（需人工补链接，非本次自动范围）───");
    const byUserM = new Map<string, Manual[]>();
    for (const mm of manual) {
      if (!byUserM.has(mm.userId)) byUserM.set(mm.userId, []);
      byUserM.get(mm.userId)!.push(mm);
    }
    for (const [uid, list] of [...byUserM.entries()].sort((a, b) => b[1].length - a[1].length)) {
      console.log(`  【${uname(uid)} (uid=${uid})】${list.length} 条`);
    }
  }

  if (APPLY && safeFixes.length > 0) {
    console.log(`\n=== 开始写库：改 ${safeFixes.length} 条同账号广告归属 ===`);
    let done = 0;
    for (const f of safeFixes) {
      await prisma.campaigns.update({ where: { id: BigInt(f.campaignId) }, data: { platform_connection_id: BigInt(f.toConn) } });
      done++;
      if (done % 20 === 0) console.log(`  已改 ${done}/${safeFixes.length}`);
    }
    console.log(`✅ 完成：改归属 ${done} 条（同账号）；跨账号 ${crossFixes.length} 条未动，需人工确认`);
  } else if (!APPLY) {
    console.log(`\n（DRY-RUN，未写库。确认无误后加 --apply 执行；--apply 只改同账号那 ${safeFixes.length} 条）`);
  }

  await prisma.$disconnect();
}
main().catch((e) => { console.error(e); process.exit(1); });
