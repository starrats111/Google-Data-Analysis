/**
 * D-180 dry-run：模拟「全员按当前 account_index 确认」后，重排模块会做什么。
 * 只读——reassignByConfirmedIndex(dryRun=true) 不写库。
 * 使用：npx tsx scripts/d180-dryrun-reassign.ts
 */
import { loadEnvFromProjectRoot } from "./load-env-from-dotenv-file";

async function main() {
  loadEnvFromProjectRoot();
  const { default: prisma } = await import("../src/lib/prisma");
  const { normalizePlatformCode } = await import("../src/lib/constants");
  const { reassignByConfirmedIndex } = await import("../src/lib/account-index-reassign");
  const conns = await prisma.platform_connections.findMany({
    where: { is_deleted: 0 },
    select: { user_id: true, platform: true },
  });
  const pairs = new Map<string, { userId: bigint; platform: string }>();
  for (const c of conns) {
    const p = normalizePlatformCode(c.platform);
    pairs.set(`${c.user_id}_${p}`, { userId: c.user_id, platform: p });
  }
  console.log(`共 ${pairs.size} 个 (user, platform) 组合待 dry-run`);

  let totReassign = 0, totMigrate = 0, totManual = 0, totSkip = 0;

  for (const { userId, platform } of pairs.values()) {
    const r = await reassignByConfirmedIndex(userId, platform, true);
    if (
      r.campaignsReassigned.length === 0 &&
      r.linkMigrations.length === 0 &&
      r.campaignsSkipped.length === 0
    ) continue;

    const user = await prisma.users.findUnique({ where: { id: userId }, select: { username: true } });
    console.log(`\n===== user=${user?.username ?? userId} platform=${platform} =====`);
    for (const c of r.campaignsReassigned) {
      console.log(`  [重排] ${c.campaignName}  conn ${c.fromConnId ?? "NULL"} -> ${c.toConnId} (序号${c.accountIndex})`);
    }
    for (const s of r.campaignsSkipped) {
      console.log(`  [跳过] ${s.campaignName}  ${s.reason}`);
    }
    for (const l of r.linkMigrations) {
      console.log(`  [链接${l.migrated ? "迁移" : "人工"}] ${l.merchantName}  key ${l.fromKey || "-"} -> ${l.toKey}${l.reason ? `  (${l.reason})` : ""}`);
    }
    totReassign += r.campaignsReassigned.length;
    totSkip += r.campaignsSkipped.length;
    totMigrate += r.linkMigrations.filter((l) => l.migrated || (!l.migrated && !l.reason?.includes("人工") && l.fromKey)).length;
    totManual += r.linkMigrations.filter((l) => !l.fromKey).length;
  }

  console.log(`\n===== 汇总 =====`);
  console.log(`广告归属重排: ${totReassign}  跳过(无对应序号连接): ${totSkip}`);
  console.log(`链接键可自动迁移: ${totMigrate}  需人工补链接: ${totManual}`);
  await prisma.$disconnect();
}

main().catch((e) => { console.error(e); process.exit(1); });
