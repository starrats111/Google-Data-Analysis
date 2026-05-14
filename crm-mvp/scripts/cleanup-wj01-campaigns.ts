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
  | "dump" | "legacy" | "purge" | "reorder" | "verify" | "patch-disabled"
  | "legacy-to-sr" | "fix-118" | "fix-8619-google";

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
    fs.writeFileSync(file, JSON.stringify(failedRows, bigintReplacer, 2), "utf8");
    log(`[purge] ${failedRows.length} 条 Google REMOVE 失败已记录: ${file}`);
  }

  await prisma.$disconnect();
}

function bigintReplacer(_k: string, v: unknown): unknown {
  return typeof v === "bigint" ? v.toString() : v;
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
    fs.writeFileSync(file, JSON.stringify(failedRows, bigintReplacer, 2), "utf8");
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

/** patch-disabled：把账户已停用、Google rename 失败的广告也加 LEGACY- 前缀 + 软删，让它们脱离序号空间 */
async function phasePatchDisabled() {
  const { prisma } = await loadDeps();
  const user = await getUser(prisma);

  // 这 3 个 CID 在 Google 侧已停用，无法 rename / 投放
  const disabledIds = [8213n, 8312n, 8600n];
  const rows = await prisma.campaigns.findMany({
    where: { id: { in: disabledIds }, user_id: user.id, is_deleted: 0 },
    select: { id: true, campaign_name: true, google_status: true, customer_id: true },
  });

  log(`[patch-disabled] 处理 Google rename 失败（账户已停用）的广告 (mode=${APPLY ? "APPLY" : "DRY-RUN"})`);
  for (const r of rows) {
    if ((r.campaign_name ?? "").startsWith("LEGACY-")) {
      log(`  [=] id=${r.id} 已是 LEGACY- 前缀，跳过`);
      continue;
    }
    const newName = `LEGACY-${r.campaign_name}`;
    log(`  [→] id=${r.id} CID=${r.customer_id} ${r.campaign_name} → ${newName}`);
    if (APPLY) {
      await prisma.campaigns.update({
        where: { id: r.id },
        data: { campaign_name: newName, is_deleted: 1 },
      });
    }
  }
  if (!APPLY) log(`[patch-disabled] dry-run；加 --apply 真改`);
  await prisma.$disconnect();
}

/**
 * legacy-to-sr：DB 把所有 LEGACY- 前缀改为 SR-；Google 端如果还没前缀则同步加 SR-。
 *
 * 背景：phaseLegacy 当初只改了 DB，Google 端没动。后来用户在 Google Ads 后台手动给
 * 部分 campaign 加了 SR- 前缀。本 phase 统一前缀为 SR-（DB 全改 + Google 端补齐缺失）。
 *
 * 幂等：跳过已是 SR- 的；Google 端如果当前名字已 startsWith SR- 也跳过。
 */
async function phaseLegacyToSr() {
  const { prisma, renameCampaign } = await loadDeps();
  const user = await getUser(prisma);

  const rows = await prisma.campaigns.findMany({
    where: {
      user_id: user.id,
      is_deleted: 0,
      OR: [
        { campaign_name: { startsWith: "LEGACY-" } },
        { campaign_name: { startsWith: "SR-" } },
      ],
    },
    select: {
      id: true, campaign_name: true, google_campaign_id: true,
      customer_id: true, mcc_id: true, google_status: true,
    },
  });

  log(`[legacy-to-sr] 共 ${rows.length} 条 LEGACY-/SR- 前缀广告 (mode=${APPLY ? "APPLY" : "DRY-RUN"})`);

  // 目标名：剥掉 LEGACY-/SR- 前缀后加 SR-（幂等）
  const targets = rows.map((r) => {
    const name = r.campaign_name ?? "";
    let bare = name;
    if (bare.startsWith("LEGACY-")) bare = bare.slice("LEGACY-".length);
    if (bare.startsWith("SR-")) bare = bare.slice("SR-".length);
    const newName = `SR-${bare}`;
    return { row: r, oldName: name, newName, needDb: name !== newName };
  });

  for (const t of targets) {
    log(`  ${t.needDb ? "[→]" : "[=]"} id=${t.row.id} ${t.oldName}${t.needDb ? `\n         ↳ ${t.newName}` : ""}`);
  }

  if (!APPLY) {
    log(`[legacy-to-sr] dry-run；加 --apply 真改 DB+Google`);
    await prisma.$disconnect();
    return;
  }

  // DB 改名（不论 Google rename 是否成功都改 DB，让 DB 保持目标态）
  let dbRenamed = 0;
  for (const t of targets) {
    if (!t.needDb) continue;
    await prisma.campaigns.update({ where: { id: t.row.id }, data: { campaign_name: t.newName } });
    dbRenamed++;
  }
  log(`[legacy-to-sr] DB 重命名: ${dbRenamed} 条`);

  // Google 端 rename：只对有 gcid+customer_id+mcc_id 的；并发 2
  const googleTargets = targets.filter((t) => t.row.google_campaign_id && t.row.customer_id && t.row.mcc_id != null);
  const mccIds = new Set<bigint>();
  for (const t of googleTargets) if (t.row.mcc_id != null) mccIds.add(t.row.mcc_id);
  const mccMap = await loadMccCache(prisma, mccIds);

  let okGoogle = 0, failGoogle = 0, skipGoogle = 0;
  const failedRows: Array<{ id: bigint; oldName: string; newName: string; err: string }> = [];

  await runPool(googleTargets, CONCURRENCY, async (t, idx) => {
    const mcc = mccMap.get(String(t.row.mcc_id));
    if (!mcc || !mcc.developer_token || !mcc.service_account_json) {
      skipGoogle++;
      log(`  [${idx + 1}/${googleTargets.length}] SKIP id=${t.row.id}（mcc 凭证缺失）`);
      return;
    }
    const creds = { mcc_id: mcc.mcc_id, developer_token: mcc.developer_token, service_account_json: mcc.service_account_json };
    try {
      const result = await renameCampaign(creds, t.row.customer_id!, t.row.google_campaign_id!, t.newName);
      if (result.success) {
        okGoogle++;
        log(`  [${idx + 1}/${googleTargets.length}] OK id=${t.row.id} → ${t.newName}`);
      } else {
        failGoogle++;
        failedRows.push({ id: t.row.id, oldName: t.oldName, newName: t.newName, err: result.message });
        log(`  [${idx + 1}/${googleTargets.length}] FAIL id=${t.row.id}: ${result.message.slice(0, 120)}`);
      }
    } catch (e) {
      failGoogle++;
      const err = e instanceof Error ? e.message : String(e);
      failedRows.push({ id: t.row.id, oldName: t.oldName, newName: t.newName, err });
      log(`  [${idx + 1}/${googleTargets.length}] ERR id=${t.row.id}: ${err.slice(0, 120)}`);
    }
  });
  log(`[legacy-to-sr] Google rename: ok=${okGoogle} fail=${failGoogle} skip=${skipGoogle}`);

  if (failedRows.length > 0) {
    const dir = path.join(process.cwd(), "tmp");
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    const ts = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
    const file = path.join(dir, `wj01-legacy-to-sr-failed-${ts}.json`);
    fs.writeFileSync(file, JSON.stringify(failedRows, bigintReplacer, 2), "utf8");
    log(`[legacy-to-sr] ${failedRows.length} 条失败已记录: ${file}`);
  }

  await prisma.$disconnect();
}

/**
 * fix-118：把 wj01 新建的 118-PM1-WalkingPadUSUKEU 改名为 041-PM1-WalkingPadUSUKEU
 *
 * 背景：清洗后 0509+ 重排到 001-040；但因 2 条漏网 REMOVED 占着 117，
 * 之后用户新建的广告被分配到了 118。现在 117 已清掉，把 118 改回 041。
 *
 * 幂等：若 campaign_name 已是 041- 开头则跳过。
 */
async function phaseFix118() {
  const { prisma, renameCampaign } = await loadDeps();
  const user = await getUser(prisma);

  const TARGET_ID = 8621n;
  const row = await prisma.campaigns.findFirst({
    where: { id: TARGET_ID, user_id: user.id, is_deleted: 0 },
    select: {
      id: true, campaign_name: true, google_campaign_id: true,
      customer_id: true, mcc_id: true,
    },
  });
  if (!row) {
    log(`[fix-118] id=${TARGET_ID} 不存在或已软删，跳过`);
    await prisma.$disconnect();
    return;
  }

  const oldName = row.campaign_name ?? "";
  const parts = oldName.split("-");
  if (parts[0] === "041") {
    log(`[fix-118] id=${row.id} 已是 041 开头：${oldName}，幂等跳过`);
    await prisma.$disconnect();
    return;
  }
  const rest = parts.slice(1).join("-");
  const newName = `041-${rest}`;
  log(`[fix-118] id=${row.id} (mode=${APPLY ? "APPLY" : "DRY-RUN"})`);
  log(`  [→] ${oldName}\n         ↳ ${newName}`);

  if (!APPLY) {
    log(`[fix-118] dry-run；加 --apply 真改 DB+Google`);
    await prisma.$disconnect();
    return;
  }

  if (!row.google_campaign_id || !row.customer_id || row.mcc_id == null) {
    log(`[fix-118] 缺少 gcid/customer_id/mcc_id，无法 Google rename`);
    await prisma.$disconnect();
    return;
  }
  const mccMap = await loadMccCache(prisma, new Set([row.mcc_id]));
  const mcc = mccMap.get(String(row.mcc_id));
  if (!mcc || !mcc.developer_token || !mcc.service_account_json) {
    log(`[fix-118] mcc 凭证缺失，跳过`);
    await prisma.$disconnect();
    return;
  }

  const creds = { mcc_id: mcc.mcc_id, developer_token: mcc.developer_token, service_account_json: mcc.service_account_json };
  const result = await renameCampaign(creds, row.customer_id, row.google_campaign_id, newName);
  if (!result.success) {
    log(`[fix-118] ❌ Google rename 失败: ${result.message}`);
    await prisma.$disconnect();
    return;
  }
  log(`[fix-118] ✅ Google rename 成功`);
  await prisma.campaigns.update({ where: { id: row.id }, data: { campaign_name: newName } });
  log(`[fix-118] ✅ DB 同步 ${oldName} → ${newName}`);
  await prisma.$disconnect();
}

/**
 * fix-8619-google：把 8619 Google 端的名字同步成 DB 的 040-PM1-wwwfreeskycyclecom-US-0514-92029
 *
 * 背景：reorder 阶段 DB 已改成 040-PM1-...，但 Google 端疑似未生效（仍为 40-PM-US-freeskycycle-0514-92029）。
 */
async function phaseFix8619Google() {
  const { prisma, renameCampaign } = await loadDeps();
  const user = await getUser(prisma);

  const TARGET_ID = 8619n;
  const row = await prisma.campaigns.findFirst({
    where: { id: TARGET_ID, user_id: user.id, is_deleted: 0 },
    select: {
      id: true, campaign_name: true, google_campaign_id: true,
      customer_id: true, mcc_id: true,
    },
  });
  if (!row) {
    log(`[fix-8619-google] id=${TARGET_ID} 不存在`);
    await prisma.$disconnect();
    return;
  }

  log(`[fix-8619-google] id=${row.id} DB 名: ${row.campaign_name} (mode=${APPLY ? "APPLY" : "DRY-RUN"})`);
  log(`  目标：让 Google 端名字 = DB 名字（${row.campaign_name}）`);

  if (!APPLY) {
    log(`[fix-8619-google] dry-run；加 --apply 真改 Google`);
    await prisma.$disconnect();
    return;
  }

  if (!row.google_campaign_id || !row.customer_id || row.mcc_id == null) {
    log(`[fix-8619-google] 缺少 gcid/customer_id/mcc_id，跳过`);
    await prisma.$disconnect();
    return;
  }
  const mccMap = await loadMccCache(prisma, new Set([row.mcc_id]));
  const mcc = mccMap.get(String(row.mcc_id));
  if (!mcc || !mcc.developer_token || !mcc.service_account_json) {
    log(`[fix-8619-google] mcc 凭证缺失，跳过`);
    await prisma.$disconnect();
    return;
  }

  const creds = { mcc_id: mcc.mcc_id, developer_token: mcc.developer_token, service_account_json: mcc.service_account_json };
  const result = await renameCampaign(creds, row.customer_id, row.google_campaign_id, row.campaign_name!);
  if (result.success) log(`[fix-8619-google] ✅ Google rename 成功`);
  else log(`[fix-8619-google] ❌ Google rename 失败: ${result.message}`);
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
    case "patch-disabled": await phasePatchDisabled(); break;
    case "legacy-to-sr": await phaseLegacyToSr(); break;
    case "fix-118": await phaseFix118(); break;
    case "fix-8619-google": await phaseFix8619Google(); break;
    default:
      console.error(`未知 phase: ${PHASE}`);
      process.exit(1);
  }
}

main().catch((e) => {
  console.error("❌ 执行失败:", e);
  process.exit(1);
});
