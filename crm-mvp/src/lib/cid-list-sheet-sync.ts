/**
 * D-266 批二：CID_List 每日自动比对同步（07 批复 #3，2026-08-21）
 *
 * 数据通道：读走 Sheet——统一 Ads Script 每次运行整表重写 CID_List tab
 * （CustomerID / AccountName，AdsManagerApp.accounts() 全量子账号），
 * CRM 每日与 mcc_cid_accounts 比对，不一致自动同步，不再依赖人工点「同步CID」按钮
 * （D-253 病根：CID 登记无自动链路，wj04 十几个在用 CID 成花费盲区）。
 *
 * 与 API 登记按钮（listMccChildAccounts）的语义差异——刻意保守：
 * - API 的 customer_client 查询只返回 ENABLED 子账号，「出现在列表」即 Google 真值 ENABLED；
 *   Ads Script 的 accounts() 迭代器**不过滤账号状态**（suspended 也可能在列），
 *   所以「出现在 Sheet」不能当 ENABLED 证据 → 本同步【绝不】把 suspended/cancelled 行
 *   自动复活成 active（否则 D-248 被中止锁操作会被洗白），恢复仍走 API 按钮/管理员。
 * - 消失判定与 API 口径一致：active 行不在 Sheet → status=cancelled + is_available=D（终态）。
 *
 * 失败与不确定路径（质量闸第 3 条，显式设计）：
 * - Sheet 拉取失败 / 无 CID_List tab / 表头不符 / 0 数据行 → 整个 MCC 跳过不动库
 *   （脚本 clearContents 后中断会留下空表，若当真会把全部 CID 误判成消失）；
 * - 缩水保护：Sheet 行数 < 库内 active 数一半 且 消失 ≥5 个 → 只处理新增，跳过取消，
 *   记 warning 留人工复核（残表/半写表防线）。
 */
import prisma from "@/lib/prisma";
import { extractSheetId, readSheetCsv } from "@/lib/sheet-sync";

export interface CidListRow {
  customer_id: string; // 纯数字（Sheet 里带横杠，解析时归一）
  customer_name: string;
}

export interface CidDiffAction {
  create: CidListRow[];
  rename: Array<{ id: bigint; customer_name: string }>;
  cancel: Array<{ id: bigint; customer_id: string }>;
  /** 消失但名下仍有 ENABLED 系列——矛盾态（可能是 MCC 里被「隐藏」的活账号），不取消只告警 */
  cancelBlocked: Array<{ id: bigint; customer_id: string }>;
  /** 在 Sheet 里但库内为 suspended/cancelled 的行数（不动，仅统计） */
  presentButDisabled: number;
  /** 缩水保护触发：本轮跳过取消 */
  cancelSkippedByGuard: boolean;
}

export interface ExistingCidRow {
  id: bigint;
  customer_id: string;
  customer_name: string | null;
  status: string;
}

/** Sheet CID_List 表头解析：返回 null 表示表头不符（老脚本/别的格式），调用方跳过 */
export function parseCidListRows(rows: string[][]): CidListRow[] | null {
  if (rows.length === 0) return null;
  const hdr = rows[0].map((h) => h.trim().toLowerCase());
  const ci = hdr.indexOf("customerid");
  const ni = hdr.indexOf("accountname");
  if (ci < 0 || ni < 0) return null;
  const out: CidListRow[] = [];
  const seen = new Set<string>();
  for (const r of rows.slice(1)) {
    const cid = (r[ci] ?? "").replace(/\D/g, "");
    if (!cid || cid.length < 8 || seen.has(cid)) continue; // CID 是 10 位数字，容错到 8 位下限
    seen.add(cid);
    out.push({ customer_id: cid, customer_name: (r[ni] ?? "").trim() });
  }
  return out;
}

/**
 * 纯 diff 逻辑（可单测）：Sheet 全量 vs 库内未删行 → 动作 + 保护判定。
 * enabledCids = 该 MCC 下仍有 ENABLED 系列的 CID 集合（纯数字），用作取消佐证：
 * 迭代器会排除 MCC 里被「隐藏」的账号，隐藏 ≠ 中止——消失但名下还有 ENABLED 系列的
 * 属矛盾态，标 cancelled 会把在投广告误锁成「被中止」（D-248 派生展示），只告警不取消。
 */
export function diffCidList(
  sheetRows: CidListRow[],
  existing: ExistingCidRow[],
  enabledCids: Set<string> = new Set(),
): CidDiffAction {
  const sheetMap = new Map(sheetRows.map((r) => [r.customer_id, r]));
  const existingMap = new Map(existing.map((r) => [r.customer_id, r]));

  const create: CidListRow[] = [];
  const rename: Array<{ id: bigint; customer_name: string }> = [];
  let presentButDisabled = 0;

  for (const row of sheetRows) {
    const ex = existingMap.get(row.customer_id);
    if (!ex) {
      create.push(row);
      continue;
    }
    if (ex.status !== "active") {
      // 出现在 Sheet ≠ ENABLED（迭代器不过滤状态），不自动复活，恢复走 API 按钮
      presentButDisabled++;
      continue;
    }
    if (row.customer_name && row.customer_name !== (ex.customer_name || "")) {
      rename.push({ id: ex.id, customer_name: row.customer_name });
    }
  }

  const missingActive = existing.filter((ex) => ex.status === "active" && !sheetMap.has(ex.customer_id));
  const activeCount = existing.filter((ex) => ex.status === "active").length;
  // 缩水保护：疑似残表（脚本中断在 clearContents 与写完之间）
  const cancelSkippedByGuard = missingActive.length >= 5 && sheetRows.length < activeCount * 0.5;

  const cancel: Array<{ id: bigint; customer_id: string }> = [];
  const cancelBlocked: Array<{ id: bigint; customer_id: string }> = [];
  if (!cancelSkippedByGuard) {
    for (const ex of missingActive) {
      if (enabledCids.has(ex.customer_id)) {
        cancelBlocked.push({ id: ex.id, customer_id: ex.customer_id });
      } else {
        cancel.push({ id: ex.id, customer_id: ex.customer_id });
      }
    }
  }

  return { create, rename, cancel, cancelBlocked, presentButDisabled, cancelSkippedByGuard };
}

export interface CidListSyncStats {
  mccs: number;
  skipped: number;
  created: number;
  renamed: number;
  cancelled: number;
  guardTriggered: number;
  warnings: string[];
}

/** 每日执行入口（daily-sync Step 2.4 挂载）：逐 MCC 读 Sheet CID_List 并比对入库 */
export async function syncCidListFromSheets(log: (msg: string) => void): Promise<CidListSyncStats> {
  const stats: CidListSyncStats = { mccs: 0, skipped: 0, created: 0, renamed: 0, cancelled: 0, guardTriggered: 0, warnings: [] };

  const mccs = await prisma.google_mcc_accounts.findMany({
    where: { is_deleted: 0, sheet_url: { not: null } },
    select: { id: true, mcc_id: true, mcc_name: true, sheet_url: true },
  });

  for (const mcc of mccs) {
    const label = mcc.mcc_name || mcc.mcc_id;
    const sid = extractSheetId(mcc.sheet_url || "");
    if (!sid) { stats.skipped++; continue; }

    let rows: string[][];
    try {
      rows = await readSheetCsv(sid, "CID_List");
    } catch (e) {
      stats.skipped++;
      log(`  [CID_List] ${label}: 拉取失败跳过（${e instanceof Error ? e.message.slice(0, 120) : e}）`);
      continue;
    }
    const sheetRows = parseCidListRows(rows);
    if (!sheetRows || sheetRows.length === 0) {
      // 无 tab / 老格式 / 空表（可能是脚本中断残表）——一律不动库
      stats.skipped++;
      continue;
    }

    const existing = await prisma.mcc_cid_accounts.findMany({
      where: { mcc_account_id: mcc.id, is_deleted: 0 },
      select: { id: true, customer_id: true, customer_name: true, status: true },
    });

    // 取消佐证：名下仍有 ENABLED 系列的 CID（campaigns.customer_id 可能带横杠，归一后比对）
    const enabledRows = await prisma.campaigns.findMany({
      where: { mcc_id: mcc.id, is_deleted: 0, google_status: "ENABLED" },
      select: { customer_id: true },
      distinct: ["customer_id"],
    });
    const enabledCids = new Set(enabledRows.map((r) => (r.customer_id || "").replace(/\D/g, "")).filter(Boolean));

    const diff = diffCidList(sheetRows, existing, enabledCids);
    stats.mccs++;

    if (diff.cancelSkippedByGuard) {
      stats.guardTriggered++;
      const w = `${label}: Sheet 仅 ${sheetRows.length} 行但库内 active 较多，疑似残表——本轮只登记新增、跳过取消，请人工复核`;
      stats.warnings.push(w);
      log(`  [CID_List] ⚠️ ${w}`);
    }

    for (const row of diff.create) {
      // 数据真实性规范：只写标识字段，可用性 U（未核实）等状态同步核实后转 Y/N
      await prisma.mcc_cid_accounts.create({
        data: {
          mcc_account_id: mcc.id,
          customer_id: row.customer_id,
          customer_name: row.customer_name || null,
          is_available: "U",
          status: "active",
          last_synced_at: new Date(),
        },
      }).catch(() => { /* 并发 uk_mcc_cid 冲突忽略 */ });
      stats.created++;
    }
    for (const r of diff.rename) {
      await prisma.mcc_cid_accounts.update({
        where: { id: r.id },
        data: { customer_name: r.customer_name, last_synced_at: new Date() },
      });
      stats.renamed++;
    }
    for (const c of diff.cancel) {
      await prisma.mcc_cid_accounts.update({
        where: { id: c.id },
        data: { status: "cancelled", is_available: "D", last_synced_at: new Date() },
      });
      stats.cancelled++;
    }
    if (diff.cancelBlocked.length > 0) {
      const w = `${label}: ${diff.cancelBlocked.length} 个 CID 不在 Sheet 但名下仍有 ENABLED 系列（可能被 MCC「隐藏」），不自动取消：${diff.cancelBlocked.map((c) => c.customer_id).join("/")}`;
      stats.warnings.push(w);
      log(`  [CID_List] ⚠️ ${w}`);
    }

    if (diff.create.length || diff.cancel.length || diff.rename.length) {
      log(`  [CID_List] ${label}: Sheet ${sheetRows.length} 个 CID，新增 ${diff.create.length}、改名 ${diff.rename.length}、取消 ${diff.cancel.length}${diff.presentButDisabled ? `、停用在列不复活 ${diff.presentButDisabled}` : ""}`);
    }
  }

  log(`  [CID_List] 完成：比对 ${stats.mccs} 个 MCC（跳过 ${stats.skipped}），新增 ${stats.created}、改名 ${stats.renamed}、取消 ${stats.cancelled}${stats.guardTriggered ? `、缩水保护触发 ${stats.guardTriggered}` : ""}`);
  return stats;
}
