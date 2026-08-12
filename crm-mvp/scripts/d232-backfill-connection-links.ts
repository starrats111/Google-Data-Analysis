/**
 * D-232 修复：同平台多联盟账号时，`user_merchants.connection_campaign_links` 里缺少
 * 部分账号的追踪链接 → 领取/新增广告被「所选账号未配置该商家追踪链接」硬拦。
 *
 * 病灶：每日 00:00 的 `daily-merchant-check` 是唯一的定时商家刷新，它只写单值
 * `tracking_link/campaign_link`（第一个返回该商家的账号），从不写 `connection_campaign_links`；
 * 而做多账号合并的全量同步（`/api/user/merchants/sync`）只在用户手点「同步商家」时才跑。
 * 于是后加入的第 2、3 个账号，其链接永远进不了库。
 *
 * 本脚本只做一件事：按官方平台 API 逐账号取回 joined 商家的真实追踪链接，
 * 补进 `connection_campaign_links` 缺失的键，不删键，
 * 不动 status / tracking_link / campaign_link / 广告归属，不删任何行。
 *
 * 默认不覆盖已有值：RW 实测每次调 merchant_details 返回的 tracking_url 都是全新随机 token
 * （同 token 同 mid 连查两次得两条不同且都有效的链接），覆盖等于纯写放大。
 * 确需换成本次取回的链接（例如怀疑历史链接已失效）才加 `--refresh`。
 *
 * 用法（服务器上，crm-mvp 目录）：
 *   npx tsx scripts/d232-backfill-connection-links.ts --user=11 --platform=RW          # dry-run
 *   npx tsx scripts/d232-backfill-connection-links.ts --user=11 --platform=RW --apply  # 写库
 *   npx tsx scripts/d232-backfill-connection-links.ts --apply                          # 全部多账号组
 */
import { loadEnvFromProjectRoot } from "./load-env-from-dotenv-file";
loadEnvFromProjectRoot();

const APPLY = process.argv.includes("--apply");
const REFRESH = process.argv.includes("--refresh");
const argUser = process.argv.find((a) => a.startsWith("--user="))?.split("=")[1];
const argPlatform = process.argv.find((a) => a.startsWith("--platform="))?.split("=")[1]?.toUpperCase();

const MERCHANT_PAGE = 500;
const UPDATE_CONCURRENCY = 8;

function asLinks(raw: unknown): Record<string, string> {
  if (raw && typeof raw === "object" && !Array.isArray(raw)) return raw as Record<string, string>;
  return {};
}

async function main() {
  const { prisma } = await import("@/lib/prisma");
  const { fetchAllMerchants } = await import("@/lib/platform-api");

  console.log(
    `\n=== D-232 回填各账号商家追踪链接 ${APPLY ? "【APPLY 写库】" : "【DRY-RUN 只读】"}` +
    `${REFRESH ? "【REFRESH 覆盖已有链接】" : ""} ===\n`,
  );

  const conns = await prisma.platform_connections.findMany({
    where: {
      is_deleted: 0,
      ...(argUser ? { user_id: BigInt(argUser) } : {}),
      ...(argPlatform ? { platform: argPlatform } : {}),
    },
    select: { id: true, user_id: true, platform: true, account_name: true, api_key: true, account_index: true },
    orderBy: [{ user_id: "asc" }, { platform: "asc" }, { id: "asc" }],
  });

  // 按 user+platform 分组，只处理同平台 2 个及以上账号的组（单账号组走单值字段即可，无需合并）
  const groups = new Map<string, typeof conns>();
  for (const c of conns) {
    const k = `${c.user_id}:${c.platform}`;
    const arr = groups.get(k) || [];
    arr.push(c);
    groups.set(k, arr);
  }

  let totalUpdated = 0;
  for (const [key, groupConns] of groups) {
    const [userIdStr, platform] = key.split(":");
    const usable = groupConns.filter((c) => c.api_key && c.api_key.length > 5);
    if (usable.length < 2) continue;

    const label = `user=${userIdStr} ${platform} (${usable.map((c) => `${c.id}/${c.account_name}`).join(", ")})`;
    console.log(`--- ${label} ---`);

    // 逐账号串行拉取（同平台并发会把 RW/LH 这类服务端拖到超时）
    const linksByConn = new Map<string, Map<string, string>>();
    for (const c of usable) {
      const t0 = Date.now();
      let fetched: Awaited<ReturnType<typeof fetchAllMerchants>>;
      try {
        fetched = await fetchAllMerchants(platform, c.api_key!, "joined");
      } catch (e) {
        console.log(`  conn ${c.id} ${c.account_name}: 拉取异常 ${e instanceof Error ? e.message : String(e)}，跳过`);
        continue;
      }
      const withLink = new Map<string, string>();
      for (const m of fetched.merchants) {
        if (m.relationship_status !== "joined") continue;
        if (!m.merchant_id || !m.campaign_link) continue;
        withLink.set(m.merchant_id, m.campaign_link);
      }
      console.log(
        `  conn ${c.id} ${c.account_name}: joined=${fetched.merchants.length} 带链接=${withLink.size} ` +
        `${((Date.now() - t0) / 1000).toFixed(0)}s${fetched.error ? ` err=${fetched.error}` : ""}`,
      );
      // 拿不到任何链接的账号不参与合并（避免把一次失败的拉取当成「该账号没链接」）
      if (withLink.size > 0) linksByConn.set(c.id.toString(), withLink);
    }
    if (linksByConn.size === 0) { console.log("  无可用数据，跳过\n"); continue; }

    // 逐页扫该用户该平台的商家，只补缺失/过期的键
    let cursor: bigint | null = null;
    let scanned = 0, changed = 0;
    for (;;) {
      const rows: Array<{ id: bigint; merchant_id: string; connection_campaign_links: unknown }> =
        await prisma.user_merchants.findMany({
          where: {
            user_id: BigInt(userIdStr),
            platform,
            is_deleted: 0,
            ...(cursor ? { id: { gt: cursor } } : {}),
          },
          select: { id: true, merchant_id: true, connection_campaign_links: true },
          orderBy: { id: "asc" },
          take: MERCHANT_PAGE,
        });
      if (rows.length === 0) break;
      cursor = rows[rows.length - 1].id;
      scanned += rows.length;

      const pending: Array<{ id: bigint; links: Record<string, string> }> = [];
      for (const r of rows) {
        const links = asLinks(r.connection_campaign_links);
        let dirty = false;
        for (const [connId, map] of linksByConn) {
          const real = map.get(r.merchant_id);
          if (!real) continue;
          const has = typeof links[connId] === "string" && links[connId].trim();
          if (has && !REFRESH) continue;
          if (links[connId] === real) continue;
          links[connId] = real;
          dirty = true;
        }
        if (dirty) pending.push({ id: r.id, links });
      }

      for (let i = 0; i < pending.length; i += UPDATE_CONCURRENCY) {
        const batch = pending.slice(i, i + UPDATE_CONCURRENCY);
        if (APPLY) {
          await Promise.all(batch.map((p) =>
            prisma.user_merchants.update({ where: { id: p.id }, data: { connection_campaign_links: p.links } })
              .catch((e) => console.log(`  UPDATE FAIL id=${p.id} ${e instanceof Error ? e.message : String(e)}`)),
          ));
        }
        changed += batch.length;
      }
    }
    totalUpdated += changed;
    console.log(`  扫描 ${scanned} 个商家，${APPLY ? "已补" : "待补"} ${changed} 条\n`);
  }

  console.log(`=== 合计 ${APPLY ? "已补" : "待补"} ${totalUpdated} 条${APPLY ? "" : "（dry-run，未写库；加 --apply 执行）"} ===\n`);
  await prisma.$disconnect();
}

main().catch((e) => { console.error(e); process.exit(1); });
