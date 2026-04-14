/**
 * 批量 PM 全量同步脚本
 * 用途：对所有有 PM 平台连接的用户逐一执行 PM 商家全量同步
 * 使用：npx tsx scripts/batch-sync-pm.ts
 *
 * 特性：
 * - 逐用户串行执行，避免并发压垮 PM API
 * - 每用户同步前后打印商家数量变化，实时监控
 * - 任意用户同步失败时打印错误并继续下一个（不中止整体）
 * - 支持 --dry-run 参数：仅打印计划，不实际写 DB
 * - 支持 --user=username 参数：只同步指定用户
 * - 支持 --stop-on-error：任意错误立即终止
 */

import prisma from "../src/lib/prisma";
import { fetchAllMerchants } from "../src/lib/platform-api";

const IS_DRY_RUN = process.argv.includes("--dry-run");
const STOP_ON_ERROR = process.argv.includes("--stop-on-error");
const TARGET_USER = (() => {
  const arg = process.argv.find((a) => a.startsWith("--user="));
  return arg ? arg.split("=")[1] : null;
})();

function log(msg: string) {
  console.log(`[${new Date().toISOString()}] ${msg}`);
}

function warn(msg: string) {
  console.warn(`[${new Date().toISOString()}] ⚠️  ${msg}`);
}

function die(msg: string) {
  console.error(`[${new Date().toISOString()}] ❌ FATAL: ${msg}`);
  process.exit(1);
}

async function syncUserPM(
  userId: bigint,
  username: string,
  connections: { id: bigint; account_name: string; api_key: string }[]
): Promise<{ ok: boolean; added: number; error?: string }> {
  log(`▶ [${username}] 开始 PM 同步 (${connections.length} 个连接)`);

  // 1. 拉取 PM API 数据（各连接串行）
  const allMerchants: Array<{
    merchant_id: string;
    merchant_name: string;
    category: string;
    commission_rate: string;
    supported_regions: string[];
    merchant_url: string;
    logo_url: string;
    campaign_link: string;
    relationship_status: string;
    conn_id: bigint;
  }> = [];

  for (const conn of connections) {
    log(`  [${username}] 拉取连接 ${conn.account_name} (id=${conn.id}) ...`);
    const r = await fetchAllMerchants("PM", conn.api_key, "joined");
    if (r.error) {
      warn(`  [${username}] 连接 ${conn.account_name} 拉取报错: ${r.error}`);
    }
    const joined = r.merchants.filter((m) => m.relationship_status === "joined");
    log(`  [${username}] 连接 ${conn.account_name}: API 返回 ${r.merchants.length} 条，joined=${joined.length}`);
    for (const m of joined) {
      allMerchants.push({ ...m, conn_id: conn.id });
    }
  }

  if (allMerchants.length === 0) {
    warn(`  [${username}] PM API 未返回任何 joined 商家，跳过写 DB`);
    return { ok: false, added: 0, error: "PM API 返回 0 条 joined 商家" };
  }

  // 去重（多连接可能返回相同商家）
  const seen = new Set<string>();
  const deduped = allMerchants.filter((m) => {
    if (seen.has(m.merchant_id)) return false;
    seen.add(m.merchant_id);
    return true;
  });
  log(`  [${username}] 去重后: ${deduped.length} 条`);

  if (IS_DRY_RUN) {
    log(`  [${username}] [DRY-RUN] 跳过 DB 写入`);
    return { ok: true, added: 0 };
  }

  // 2. 查当前 DB 中该用户的 PM 商家
  const existing = await prisma.user_merchants.findMany({
    where: { user_id: userId, platform: "PM", is_deleted: 0 },
    select: { id: true, merchant_id: true, status: true, platform_connection_id: true },
  });
  const existingMap = new Map(existing.map((e) => [e.merchant_id, e]));
  log(`  [${username}] DB 现有 PM 商家: ${existing.length} 条`);

  // 3. 计算新增
  const toCreate = deduped.filter((m) => !existingMap.has(m.merchant_id));
  log(`  [${username}] 新增: ${toCreate.length} 条`);

  if (toCreate.length === 0) {
    log(`  [${username}] 无新增，同步完毕`);
    return { ok: true, added: 0 };
  }

  // 4. 批量写入
  const BATCH = 200;
  let addedCount = 0;
  for (let i = 0; i < toCreate.length; i += BATCH) {
    const batch = toCreate.slice(i, i + BATCH);
    try {
      const result = await prisma.user_merchants.createMany({
        data: batch.map((m) => ({
          user_id: userId,
          platform: "PM",
          merchant_id: m.merchant_id,
          merchant_name: m.merchant_name || "",
          category: m.category || null,
          commission_rate: m.commission_rate || null,
          merchant_url: m.merchant_url || null,
          logo_url: m.logo_url || null,
          tracking_link: m.campaign_link || null,
          campaign_link: m.campaign_link || null,
          platform_connection_id: m.conn_id,
          status: "available",
          supported_regions: m.supported_regions?.length
            ? (m.supported_regions as unknown as string[])
            : undefined,
        })),
        skipDuplicates: true,
      });
      addedCount += result.count;
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      warn(`  [${username}] batch CREATE FAIL (${i}~${i + BATCH}): ${msg}`);
    }
  }

  log(`  [${username}] ✅ 写入完成，实际新增: ${addedCount} 条`);
  return { ok: true, added: addedCount };
}

async function main() {
  log("════════════════════════════════════════");
  log(`PM 批量同步脚本启动  DRY_RUN=${IS_DRY_RUN}  STOP_ON_ERROR=${STOP_ON_ERROR}  TARGET_USER=${TARGET_USER ?? "ALL"}`);
  log("════════════════════════════════════════");

  // 查询所有有有效 PM 连接
  const PLACEHOLDER_KEYS = new Set(["yz123456", "test", "demo", "placeholder"]);
  const connections = await prisma.platform_connections.findMany({
    where: { platform: "PM", is_deleted: 0, status: "connected" },
    orderBy: { user_id: "asc" },
  });

  // 过滤明显无效 key
  const validConns = connections.filter(
    (c) =>
      c.api_key &&
      c.api_key.length >= 16 &&
      !PLACEHOLDER_KEYS.has(c.api_key.toLowerCase())
  );

  // 查询用户名
  const userIds = [...new Set(validConns.map((c) => c.user_id))];
  const users = await prisma.users.findMany({
    where: { id: { in: userIds } },
    select: { id: true, username: true },
  });
  const userMap = new Map(users.map((u) => [u.id.toString(), u.username]));

  // 按用户分组
  const byUser = new Map<string, { userId: bigint; username: string; conns: typeof validConns }>();
  for (const c of validConns) {
    const username = userMap.get(c.user_id.toString());
    if (!username) continue;
    if (TARGET_USER && username !== TARGET_USER) continue;
    if (!byUser.has(username)) {
      byUser.set(username, { userId: c.user_id, username, conns: [] });
    }
    byUser.get(username)!.conns.push(c);
  }

  log(`计划同步用户数: ${byUser.size}`);
  for (const [username, { conns }] of byUser) {
    log(`  ${username}: ${conns.length} 个有效 PM 连接`);
  }
  log("────────────────────────────────────────");

  const results: Array<{ username: string; ok: boolean; added: number; error?: string }> = [];
  let hasError = false;

  for (const [, { userId, username, conns }] of byUser) {
    try {
      const r = await syncUserPM(userId, username, conns.map((c) => ({
        id: c.id,
        account_name: c.account_name,
        api_key: c.api_key!,
      })));
      results.push({ username, ...r });
      if (!r.ok && STOP_ON_ERROR) {
        die(`用户 ${username} 同步失败，--stop-on-error 已触发`);
      }
      if (!r.ok) hasError = true;
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      warn(`[${username}] 同步异常: ${msg}`);
      results.push({ username, ok: false, added: 0, error: msg });
      hasError = true;
      if (STOP_ON_ERROR) die(`用户 ${username} 抛出异常，--stop-on-error 已触发`);
    }
    log("────────────────────────────────────────");
  }

  log("════════════════════════════════════════");
  log("同步汇总：");
  let totalAdded = 0;
  for (const r of results) {
    const status = r.ok ? "✅" : "❌";
    log(`  ${status} ${r.username}: 新增 ${r.added}${r.error ? `  错误: ${r.error}` : ""}`);
    totalAdded += r.added;
  }
  log(`合计新增: ${totalAdded} 条`);
  if (hasError) log("⚠️  有部分用户同步失败，请检查上方日志");
  log("════════════════════════════════════════");

  await prisma.$disconnect();
}

main().catch((e) => {
  console.error("脚本异常退出:", e);
  process.exit(1);
});
