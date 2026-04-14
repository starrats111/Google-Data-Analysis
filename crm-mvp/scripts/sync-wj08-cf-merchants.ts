/**
 * 触发 wj08 CF 平台商家同步，补全缺失的商家记录
 * 用法：npx tsx scripts/sync-wj08-cf-merchants.ts
 */
import { loadEnvFromProjectRoot } from "./load-env-from-dotenv-file";

async function main() {
  loadEnvFromProjectRoot();
  const { default: prisma } = await import("../src/lib/prisma");
  const { fetchAllMerchants } = await import("../src/lib/platform-api");

  const user = await prisma.users.findFirst({
    where: { username: "wj08", is_deleted: 0 },
    select: { id: true, username: true },
  });
  if (!user) { console.error("❌ 用户 wj08 不存在"); process.exit(1); }
  const uid = user.id;
  console.log(`✅ 用户 wj08 (id=${uid})`);

  // 只处理 CF 平台连接
  const conns = await prisma.platform_connections.findMany({
    where: { user_id: uid, platform: "CF", is_deleted: 0 },
    select: { id: true, platform: true, account_name: true, api_key: true },
  });
  console.log(`CF 连接数: ${conns.length}`);

  const valid = conns.filter((c) => c.api_key && c.api_key.length > 5);
  if (valid.length === 0) { console.error("❌ 没有有效的 CF 连接"); process.exit(1); }

  const fetchedRows: Array<{
    platform_code: string; conn_id: bigint; merchant_id: string;
    merchant_name: string; categories: string; commission_rate: string;
    support_regions: string | null; site_url: string; campaign_link: string; logo: string;
  }> = [];

  for (const conn of valid) {
    console.log(`\n拉取 ${conn.platform} (${conn.account_name})...`);
    const r = await fetchAllMerchants(conn.platform, conn.api_key!, "joined");
    if (r.error) console.warn(`  ⚠️  ${r.error}`);
    const joined = r.merchants.filter((m) => m.relationship_status === "joined");
    console.log(`  已加入商家: ${joined.length} 条`);
    for (const m of joined) {
      fetchedRows.push({
        platform_code: conn.platform,
        conn_id: conn.id,
        merchant_id: m.merchant_id,
        merchant_name: m.merchant_name,
        categories: m.category || "",
        commission_rate: m.commission_rate || "",
        support_regions: m.supported_regions?.length ? JSON.stringify(m.supported_regions) : null,
        site_url: m.merchant_url || "",
        campaign_link: m.campaign_link || "",
        logo: m.logo_url || "",
      });
    }
  }

  if (fetchedRows.length === 0) {
    console.log("⚠️  未获取到任何商家数据");
    await prisma.$disconnect();
    return;
  }

  // 检查当前缺失的商家
  const missingMids = ["8013700", "8013875"];
  console.log("\n─── 检查目标缺失商家 ───");
  for (const mid of missingMids) {
    const found = fetchedRows.find((r) => r.merchant_id === mid);
    if (found) {
      console.log(`  ✅ ${mid}: ${found.merchant_name} — 已从 API 获取到`);
    } else {
      console.log(`  ❌ ${mid}: 未在 API 返回中找到（可能未加入或已退出）`);
    }
  }

  // 写入数据库（新增 or 更新）
  const existing = await prisma.user_merchants.findMany({
    where: { user_id: uid, platform: "CF" },
    select: { id: true, platform: true, merchant_id: true, status: true, is_deleted: true, platform_connection_id: true, connection_campaign_links: true },
  });
  const map = new Map(existing.map((m) => [`${m.platform}:${m.merchant_id}`, m]));

  let newCount = 0, updatedCount = 0;
  for (const row of fetchedRows) {
    const key = `${row.platform_code}:${row.merchant_id}`;
    const ex = map.get(key);
    let regions: unknown = null;
    if (row.support_regions) { try { regions = JSON.parse(row.support_regions); } catch {} }

    if (ex) {
      const d: Record<string, unknown> = {
        merchant_name: row.merchant_name,
        commission_rate: row.commission_rate || null,
        merchant_url: row.site_url || null,
        logo_url: row.logo || null,
        tracking_link: row.campaign_link || null,
        campaign_link: row.campaign_link || null,
      };
      if (regions != null) d.supported_regions = regions;
      if (!ex.platform_connection_id && row.conn_id) d.platform_connection_id = row.conn_id;
      if (ex.is_deleted === 1) { d.is_deleted = 0; d.status = "available"; }
      try {
        await prisma.user_merchants.update({ where: { id: ex.id }, data: d });
        updatedCount++;
      } catch (e) { console.warn(`  更新失败 ${key}: ${e}`); }
    } else {
      const d: Record<string, unknown> = {
        user_id: uid, platform: row.platform_code, merchant_id: row.merchant_id,
        merchant_name: row.merchant_name || "", commission_rate: row.commission_rate || null,
        merchant_url: row.site_url || null, logo_url: row.logo || null,
        tracking_link: row.campaign_link || null, campaign_link: row.campaign_link || null,
        platform_connection_id: row.conn_id || null, status: "available",
      };
      if (regions != null) d.supported_regions = regions;
      try {
        await prisma.user_merchants.create({ data: d as never });
        newCount++;
        if (missingMids.includes(row.merchant_id)) {
          console.log(`  🆕 新增缺失商家: ${row.merchant_id} / ${row.merchant_name}`);
        }
      } catch (e) { console.warn(`  新增失败 ${key}: ${e}`); }
    }
  }

  console.log(`\n✅ 同步完成：新增 ${newCount}，更新 ${updatedCount}，共 ${fetchedRows.length} 条`);

  // 验证缺失商家是否补全
  console.log("\n─── 验证结果 ───");
  for (const mid of missingMids) {
    const check = await prisma.user_merchants.findFirst({
      where: { user_id: uid, platform: "CF", merchant_id: mid, is_deleted: 0 },
      select: { id: true, merchant_name: true, status: true },
    });
    if (check) {
      console.log(`  ✅ ${mid}: ${check.merchant_name} (status=${check.status})`);
    } else {
      console.log(`  ❌ ${mid}: 仍然缺失 — 该商家可能未在 CJ 平台加入`);
    }
  }

  await prisma.$disconnect();
  console.log("\n🎉 完成");
}

main().catch((e) => { console.error("❌", e); process.exit(1); });
