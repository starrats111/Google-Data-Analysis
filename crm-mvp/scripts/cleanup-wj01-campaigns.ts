/**
 * C-095 wj01 广告系列大清洗
 *
 * 目标：
 *   1. 0509 前 PAUSED (537) + 4 个孤儿 PAUSED (8219/8551/8564/8566) → 软删 DB + Google Ads REMOVE
 *   2. 0509 前 ENABLED (5 个，不含 DRAFT 7197) → campaign_name 加 LEGACY- 前缀（仅 DB，Google 侧不动）
 *   3. 0509 及以后 41 个规范命名 → 按 created_at ASC 重排 001-041（DB + Google 同步 rename）
 *
 * 用法（在服务器 crm-mvp 目录下）：
 *   npx tsx scripts/cleanup-wj01-campaigns.ts --phase=dump                # 备份当前快照
 *   npx tsx scripts/cleanup-wj01-campaigns.ts --phase=legacy              # dry-run 加 LEGACY-
 *   npx tsx scripts/cleanup-wj01-campaigns.ts --phase=legacy --apply      # 真改 DB
 *   npx tsx scripts/cleanup-wj01-campaigns.ts --phase=purge               # dry-run 软删+Google REMOVE
 *   npx tsx scripts/cleanup-wj01-campaigns.ts --phase=purge --apply
 *   npx tsx scripts/cleanup-wj01-campaigns.ts --phase=reorder             # dry-run 重排 001-041
 *   npx tsx scripts/cleanup-wj01-campaigns.ts --phase=reorder --apply
 *   npx tsx scripts/cleanup-wj01-campaigns.ts --phase=verify              # 最终核对
 *
 * 安全特性：
 *   - 默认全部 dry-run，要 --apply 才真执行
 *   - Google Ads 写操作（REMOVE / rename）有并发限制（CONCURRENCY=2，避开 SerpApi 限流）
 *   - 每个阶段独立、幂等可重复
 *   - dump 阶段输出 SQL 文件可用于回滚 DB（Google 侧 REMOVE 不可回滚！）
 */
import * as fs from "fs";
import * as path from "path";
import { loadEnvFromProjectRoot } from "./load-env-from-dotenv-file";

loadEnvFromProjectRoot();

const args = process.argv.slice(2);
const APPLY = args.includes("--apply");
const PHASE = (args.find((a) => a.startsWith("--phase="))?.split("=")[1] ?? "dump") as
  | "dump" | "legacy" | "purge" | "reorder" | "verify";

const TARGET_USERNAME = "wj01";
const CUTOFF = "2026-05-09 00:00:00"; // 0509 分界线（CST，DB datetime 也按 CST 存）
const CONCURRENCY = 2; // Google Ads API 并发数，避开 RESOURCE_EXHAUSTED

const log = (...x: unknown[]) => console.log(...x);

async function loadDeps() {
  const { default: prisma } = await import("../src/lib/prisma");
  const { removeCampaign, renameCampaign } = await import("../src/lib/google-ads");
  return { prisma, removeCampaign, renameCampaign };
}

async function getUser(prisma: { users: { findFirst: (a: unknown) => Promise<{ id: bigint; username: string } | null> } }) {
  const u = await prisma.users.findFirst({
    where: { username: TARGET_USERNAME, is_deleted: 0 },
    select: { id: true, username: true },
  });
  if (!u) throw new Error(`用户 ${TARGET_USERNAME} 不存在`);
  return u;
}

type CampaignRow = {
  id: bigint;
  google_campaign_id: string | null;
  campaign_name: string | null;
  google_status: string;
  mcc_id: bigint | null;
  customer_id: string | null;
  user_merchant_id: bigint;
  created_at: Date;
};

async function fetchAllActive(prisma: any, userId: bigint): Promise<CampaignRow[]> { // eslint-disable-line @typescript-eslint/no-explicit-any
  return prisma.campaigns.findMany({
    where: { user_id: userId, is_deleted: 0 },
    select: {
      id: true, google_campaign_id: true, campaign_name: true, google_status: true,
      mcc_id: true, customer_id: true, user_merchant_id: true, created_at: true,
    },
    orderBy: [{ created_at: "asc" }, { id: "asc" }],
  });
}

/** 阶段 1：备份当前 wj01 所有未删除 campaign 快照到 SQL */
async function phaseDump() {
  const { prisma } = await loadDeps();
  const user = await getUser(prisma);
  const rows = await fetchAllActive(prisma, user.id);
  log(`[dump] wj01 (id=${user.id}) 当前未删除 campaign: ${rows.length} 条`);

  const dir = path.join(process.cwd(), "tmp");
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  const ts = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const file = path.join(dir, `wj01-campaigns-snapshot-${ts}.sql`);

  const lines: string[] = [];
  lines.push(`-- wj01 (user_id=${user.id}) campaign 快照 ${new Date().toISOString()}`);
  lines.push(`-- 用于回滚 DB 改动（注意 Google Ads REMOVE 不可回滚）`);
  lines.push(``);
  for (const r of rows) {
    const name = (r.campaign_name ?? "").replace(/'/g, "''");
    lines.push(
      `UPDATE campaigns SET campaign_name='${name}', google_status='${r.google_status}', is_deleted=0 WHERE id=${r.id};`,
    );
  }
  fs.writeFileSync(file, lines.join("\n"), "utf8");
  log(`[dump] 快照已写入 ${file}`);
  await prisma.$disconnect();
}

/** 阶段 2：5 个 0509 前 ENABLED 老广告 → campaign_name 加 LEGACY- 前缀（仅 DB） */
async function phaseLegacy() {
  const { prisma } = await loadDeps();
  const user = await getUser(prisma);
  const rows = await fetchAllActive(prisma, user.id);

  const targets = rows.filter((r) =>
    r.created_at < new Date(CUTOFF) &&
    r.google_status === "ENABLED" &&
    r.google_campaign_id !== null && // 排除 DRAFT
    !(r.campaign_name ?? "").startsWith("LEGACY-"), // 排除已加过的
  );

  log(`[legacy] 待加 LEGACY- 前缀: ${targets.length} 条 (mode=${APPLY ? "APPLY" : "DRY-RUN"})`);
  for (const r of targets) {
    const newName = `LEGACY-${r.campaign_name}`;
    log(`  [→] id=${r.id} ${r.campaign_name} → ${newName}`);
    if (APPLY) {
      await prisma.campaigns.update({ where: { id: r.id }, data: { campaign_name: newName } });
    }
  }
  if (!APPLY) log(`[legacy] dry-run 完成；加 --apply 真改 DB`);
  await prisma.$disconnect();
}

type McctRow = { id: bigint; mcc_id: string; developer_token: string | null; service_account_json: string | null };

async function loadMccCache(prisma: any, mccIds: Set<bigint>): Promise<Map<string, McctRow>> { // eslint-disable-line @typescript-eslint/no-explicit-any
  const ids = Array.from(mccIds);
  if (ids.length === 0) return new Map();
  const rows: McctRow[] = await prisma.google_mcc_accounts.findMany({
    where: { id: { in: ids }, is_deleted: 0 },
    select: { id: true, mcc_id: true, developer_token: true, service_account_json: true },
  });
  return new Map(rows.map((r) => [String(r.id), r]));
}

/** 并发执行池：保证最多 N 个并发 */
async function runPool<T, R>(items: T[], n: number, worker: (it: T, idx: number) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let cursor = 0;
  const run = async (): Promise<void> => {
    while (true) {
      const i = cursor++;
      if (i >= items.length) return;
      results[i] = await worker(items[i], i);
    }
  };
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, run));
  return results;
}

/** 阶段 3：537 个 0509 前 PAUSED + 4 个孤儿 PAUSED → 软删 DB + Google Ads REMOVE */
async function phasePurge() {
  const { prisma, removeCampaign } = await loadDeps();
  const user = await getUser(prisma);
  const rows = await fetchAllActive(prisma, user.id);

  const orphanIds = new Set([8219n, 8551n, 8564n, 8566n]);
  const targets = rows.filter((r) =>
    (r.created_at < new Date(CUTOFF) && r.google_status === "PAUSED") ||
    orphanIds.has(r.id),
  );

  log(`[purge] 待清理: ${targets.length} 条 (mode=${APPLY ? "APPLY" : "DRY-RUN"})`);
  log(`  - 0509 前 PAUSED: ${targets.filter((r) => !orphanIds.has(r.id)).length}`);
  log(`  - 孤儿 PAUSED: ${targets.filter((r) => orphanIds.has(r.id)).length}`);

  if (!APPLY) {
    log(`[purge] 前 10 条样本:`);
    for (const r of targets.slice(0, 10)) {
      log(`  [x] id=${r.id} gid=${r.google_campaign_id} ${r.campaign_name}`);
    }
    log(`[purge] dry-run 完成；加 --apply 真清理`);
    await prisma.$disconnect();
    return;
  }

  // 准备 MCC 凭证缓存
  const mccIds = new Set<bigint>();
  for (const r of targets) if (r.mcc_id != null) mccIds.add(r.mcc_id);
  const mccMap = await loadMccCache(prisma, mccIds);

  let okGoogle = 0, failGoogle = 0, skipGoogle = 0;
  const failedRows: Array<{ id: bigint; gid: string | null; err: string }> = [];

  // Step A：Google Ads 批量 REMOVE（并发 2，避开 429）
  const startedAt = Date.now();
  await runPool(targets, CONCURRENCY, async (r, idx) => {
    if (!r.google_campaign_id || !r.customer_id || r.mcc_id == null) {
      skipGoogle++;
      log(`  [${idx + 1}/${targets.length}] SKIP id=${r.id}（无 google_campaign_id/customer_id/mcc_id）`);
      return;
    }
    const mcc = mccMap.get(String(r.mcc_id));
    if (!mcc || !mcc.developer_token || !mcc.service_account_json) {
      skipGoogle++;
      log(`  [${idx + 1}/${targets.length}] SKIP id=${r.id}（mcc=${r.mcc_id} 凭证缺失）`);
      return;
    }
    const creds = { mcc_id: mcc.mcc_id, developer_token: mcc.developer_token, service_account_json: mcc.service_account_json };
    try {
      const result = await removeCampaign(creds, r.customer_id, r.google_campaign_id);
      if (result.success) {
        okGoogle++;
        if ((idx + 1) % 25 === 0) log(`  [${idx + 1}/${targets.length}] OK id=${r.id} gid=${r.google_campaign_id}`);
      } else {
        // Google 侧已经 REMOVED 等情况不算硬失败，吞掉但记录
        const lower = result.message.toLowerCase();
        const benign = lower.includes("already removed") || lower.includes("not_found") || lower.includes("invalid") || lower.includes("removed");
        if (benign) {
          okGoogle++; // 视为已达目标态
        } else {
          failGoogle++;
          failedRows.push({ id: r.id, gid: r.google_campaign_id, err: result.message });
          log(`  [${idx + 1}/${targets.length}] FAIL id=${r.id}: ${result.message.slice(0, 120)}`);
        }
      }
    } catch (e) {
      failGoogle++;
      const err = e instanceof Error ? e.message : String(e);
      failedRows.push({ id: r.id, gid: r.google_campaign_id, err });
      log(`  [${idx + 1}/${targets.length}] ERR id=${r.id}: ${err.slice(0, 120)}`);
    }
  });
  const elapsedSec = ((Date.now() - startedAt) / 1000).toFixed(1);
  log(`[purge] Google REMOVE 结果: ok=${okGoogle} fail=${failGoogle} skip=${skipGoogle} (耗时 ${elapsedSec}s)`);

  // Step B：DB 软删（不论 Google 端是否成功 — 失败的留 google_campaign_id 便于后续手动重试）
  const allIds = targets.map((r) => r.id);
  const deleted = await prisma.campaigns.updateMany({
    where: { id: { in: allIds } },
    data: { is_deleted: 1 },
  });
  log(`[purge] DB 软删: ${deleted.count} 条`);

  if (failedRows.length > 0) {
    const dir = path.join(process.cwd(), "tmp");
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    const ts = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
    const file = path.join(dir, `wj01-purge-failed-${ts}.json`);
    fs.writeFileSync(file, JSON.stringify(failedRows, null, 2));
    log(`[purge] ${failedRows.length} 条 Google REMOVE 失败已记录: ${file}`);
  }

  await prisma.$disconnect();
}

/** 阶段 4：41 个 0509+ 规范命名 → 按 created_at ASC 重排 001-041（DB + Google 同步 rename） */
async function phaseReorder() {
  const { prisma, renameCampaign } = await loadDeps();
  const user = await getUser(prisma);
  const rows = await fetchAllActive(prisma, user.id);

  // 放宽校验：只要首段是纯数字且至少 5 段就算"有序号的规范命名"
  // 兼容 MUI1 变体（country 在 parts[2]）和标准格式（country 在 parts[3]）
  // 孤儿命名 "01"/"02"/"03"（只有 1 段）和 "AC-..." (parts[0] 非数字) 都会被排除
  const isStandardName = (n: string | null) => {
    if (!n || n.startsWith("LEGACY-") || n.startsWith("DRAFT-")) return false;
    const p = n.split("-");
    if (p.length < 5) return false;
    if (!/^\d+$/.test(p[0])) return false;
    return true;
  };

  const targets = rows
    .filter((r) => r.created_at >= new Date(CUTOFF) && isStandardName(r.campaign_name))
    .sort((a, b) => {
      const ta = a.created_at.getTime(), tb = b.created_at.getTime();
      if (ta !== tb) return ta - tb;
      return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
    });

  log(`[reorder] 待重排: ${targets.length} 条 (mode=${APPLY ? "APPLY" : "DRY-RUN"})`);

  const renameMap = targets.map((r, idx) => {
    const parts = (r.campaign_name ?? "").split("-");
    const rest = parts.slice(1).join("-");
    const newSeq = String(idx + 1).padStart(3, "0");
    return { row: r, oldName: r.campaign_name ?? "", newName: `${newSeq}-${rest}` };
  });

  for (const m of renameMap) {
    const changed = m.oldName !== m.newName;
    log(`  ${changed ? "[→]" : "[=]"} id=${m.row.id} ${m.oldName}${changed ? `\n         ↳ ${m.newName}` : ""}`);
  }

  if (!APPLY) {
    log(`[reorder] dry-run 完成；加 --apply 真改 DB+Google`);
    await prisma.$disconnect();
    return;
  }

  // 准备 MCC 凭证缓存
  const mccIds = new Set<bigint>();
  for (const m of renameMap) if (m.row.mcc_id != null) mccIds.add(m.row.mcc_id);
  const mccMap = await loadMccCache(prisma, mccIds);

  let okGoogle = 0, failGoogle = 0, skipGoogle = 0;
  const failedRows: Array<{ id: bigint; oldName: string; newName: string; err: string }> = [];

  // Step A：先把 Google 侧批量 rename，并发 2
  await runPool(renameMap, CONCURRENCY, async (m, idx) => {
    if (m.oldName === m.newName) {
      okGoogle++;
      return;
    }
    if (!m.row.google_campaign_id || !m.row.customer_id || m.row.mcc_id == null) {
      skipGoogle++;
      log(`  [${idx + 1}/${renameMap.length}] SKIP id=${m.row.id}`);
      return;
    }
    const mcc = mccMap.get(String(m.row.mcc_id));
    if (!mcc || !mcc.developer_token || !mcc.service_account_json) {
      skipGoogle++;
      log(`  [${idx + 1}/${renameMap.length}] SKIP id=${m.row.id}（mcc 凭证缺失）`);
      return;
    }
    const creds = { mcc_id: mcc.mcc_id, developer_token: mcc.developer_token, service_account_json: mcc.service_account_json };
    try {
      const result = await renameCampaign(creds, m.row.customer_id, m.row.google_campaign_id, m.newName);
      if (result.success) {
        okGoogle++;
        if ((idx + 1) % 10 === 0) log(`  [${idx + 1}/${renameMap.length}] OK id=${m.row.id}`);
      } else {
        failGoogle++;
        failedRows.push({ id: m.row.id, oldName: m.oldName, newName: m.newName, err: result.message });
        log(`  [${idx + 1}/${renameMap.length}] FAIL id=${m.row.id}: ${result.message.slice(0, 120)}`);
      }
    } catch (e) {
      failGoogle++;
      const err = e instanceof Error ? e.message : String(e);
      failedRows.push({ id: m.row.id, oldName: m.oldName, newName: m.newName, err });
      log(`  [${idx + 1}/${renameMap.length}] ERR id=${m.row.id}: ${err.slice(0, 120)}`);
    }
  });
  log(`[reorder] Google rename 结果: ok=${okGoogle} fail=${failGoogle} skip=${skipGoogle}`);

  // Step B：DB 同步重命名（仅对 Google 端 ok 的行）
  const failedSet = new Set(failedRows.map((f) => String(f.id)));
  let dbRenamed = 0;
  for (const m of renameMap) {
    if (m.oldName === m.newName) continue;
    if (failedSet.has(String(m.row.id))) continue;
    await prisma.campaigns.update({ where: { id: m.row.id }, data: { campaign_name: m.newName } });
    dbRenamed++;
  }
  log(`[reorder] DB 重命名: ${dbRenamed} 条`);

  if (failedRows.length > 0) {
    const dir = path.join(process.cwd(), "tmp");
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    const ts = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
    const file = path.join(dir, `wj01-reorder-failed-${ts}.json`);
    fs.writeFileSync(file, JSON.stringify(failedRows, null, 2));
    log(`[reorder] ${failedRows.length} 条失败已记录: ${file}`);
  }

  await prisma.$disconnect();
}

/** 阶段 5：核对清洗后状态 */
async function phaseVerify() {
  const { prisma } = await loadDeps();
  const user = await getUser(prisma);
  const rows = await fetchAllActive(prisma, user.id);

  const before = rows.filter((r) => r.created_at < new Date(CUTOFF));
  const after = rows.filter((r) => r.created_at >= new Date(CUTOFF));
  const legacy = rows.filter((r) => (r.campaign_name ?? "").startsWith("LEGACY-"));
  const standardAfter = after.filter((r) => {
    const n = r.campaign_name ?? "";
    if (n.startsWith("LEGACY-") || n.startsWith("DRAFT-")) return false;
    const p = n.split("-");
    return p.length >= 5 && /^\d+$/.test(p[0]);
  });
  const seqList = standardAfter
    .map((r) => parseInt((r.campaign_name ?? "").split("-")[0], 10))
    .sort((a, b) => a - b);

  log(`\n=== wj01 清洗后核对 ===`);
  log(`未删除 campaign 总数: ${rows.length}`);
  log(`  - 0509 前: ${before.length}`);
  log(`    - 加 LEGACY- 前缀: ${legacy.length}`);
  log(`    - 其它（应只剩 DRAFT 等）: ${before.length - legacy.length}`);
  log(`  - 0509+: ${after.length}`);
  log(`    - 标准 NNN- 命名: ${standardAfter.length}`);
  log(`    - 不规范名（孤儿等）: ${after.length - standardAfter.length}`);
  log(`\n标准命名序号分布: ${seqList.length === 0 ? "(空)" : `${seqList[0]} ~ ${seqList[seqList.length - 1]} (共 ${seqList.length} 个)`}`);

  // 找 gap
  const gaps: number[] = [];
  for (let i = 1; i <= seqList.length; i++) if (!seqList.includes(i)) gaps.push(i);
  if (gaps.length > 0) log(`⚠️  序号缺口: ${gaps.slice(0, 10).join(",")}${gaps.length > 10 ? "..." : ""}`);
  else log(`✅ 序号 1-${seqList.length} 连续无缺口`);

  log(`\n样本：0509+ 前 10 条`);
  for (const r of standardAfter.slice(0, 10)) {
    log(`  ${r.campaign_name} [${r.google_status}]`);
  }

  await prisma.$disconnect();
}

async function main() {
  log(`=== C-095 wj01 广告清洗 phase=${PHASE} mode=${APPLY ? "APPLY" : "DRY-RUN"} ===\n`);
  switch (PHASE) {
    case "dump": await phaseDump(); break;
    case "legacy": await phaseLegacy(); break;
    case "purge": await phasePurge(); break;
    case "reorder": await phaseReorder(); break;
    case "verify": await phaseVerify(); break;
    default:
      console.error(`未知 phase: ${PHASE}`);
      process.exit(1);
  }
}

main().catch((e) => {
  console.error("❌ 执行失败:", e);
  process.exit(1);
});
