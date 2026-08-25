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
import { sendAlert } from "@/lib/alert";

export interface CidListRow {
  customer_id: string; // 纯数字（Sheet 里带横杠，解析时归一）
  customer_name: string;
  /**
   * D-277：Google 账户状态真值（脚本 GAQL customer_client.status 回传，大写原值
   * ENABLED/SUSPENDED/CANCELLED/CLOSED）；null/缺省=老脚本无 Status 列，跳过状态处理。
   */
  google_status?: string | null;
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
  const si = hdr.indexOf("status"); // D-277 可选列：缺列=老脚本，google_status 全 null
  if (ci < 0 || ni < 0) return null;
  const out: CidListRow[] = [];
  const seen = new Set<string>();
  for (const r of rows.slice(1)) {
    const cid = (r[ci] ?? "").replace(/\D/g, "");
    if (!cid || cid.length < 8 || seen.has(cid)) continue; // CID 是 10 位数字，容错到 8 位下限
    seen.add(cid);
    const rawStatus = si >= 0 ? (r[si] ?? "").trim().toUpperCase() : "";
    out.push({
      customer_id: cid,
      customer_name: (r[ni] ?? "").trim(),
      google_status: rawStatus || null, // 空串=Google 没给，按不确定处理（质量闸：不确定不动库）
    });
  }
  return out;
}

// ─────────────────────────────────────────────────────────────
// D-277：账户状态同步（07 2026-08-25 拍板）
// Sheet Status 列 = Google 账户状态真值 → 库内 status 跟随；
// 只自动停不自动恢复：Google 报 ENABLED 而库内被停 → 仅提醒人工确认（q5=b）。
// ─────────────────────────────────────────────────────────────

/** Google customer_client.status → 库内 status 三态；不确定值（UNKNOWN/空）返回 null 不动库 */
export function mapSheetStatus(raw: string | null | undefined): "active" | "suspended" | "cancelled" | null {
  const s = (raw || "").trim().toUpperCase();
  if (s === "ENABLED") return "active";
  if (s === "SUSPENDED") return "suspended";
  if (s === "CANCELED" || s === "CANCELLED" || s === "CLOSED") return "cancelled";
  return null;
}

export type CidStatusChangeKind = "suspend" | "cancel" | "recover_notice";

export interface CidStatusChange {
  kind: CidStatusChangeKind;
  id: bigint;
  customer_id: string;
  customer_name: string | null;
  fromStatus: string;
  /** suspend→suspended / cancel→cancelled；recover_notice 不写库 */
  toStatus: "suspended" | "cancelled" | null;
}

/**
 * 纯 diff（可单测）：Sheet 状态列 vs 库内 status。
 * - 库内 active，Sheet SUSPENDED/CANCELED → 自动标停（suspend/cancel）
 * - 库内 suspended ↔ cancelled 之间变化 → 跟随 Google 真值更新
 * - 库内被停，Sheet ENABLED → recover_notice（只提醒，不动库，恢复走人工 API 按钮）
 * - Sheet 无状态列/状态不确定/新 CID（无库内行）→ 不产生动作
 */
export function diffCidStatuses(sheetRows: CidListRow[], existing: ExistingCidRow[]): CidStatusChange[] {
  const out: CidStatusChange[] = [];
  const exMap = new Map(existing.map((r) => [r.customer_id, r]));
  for (const row of sheetRows) {
    const mapped = mapSheetStatus(row.google_status);
    if (!mapped) continue;
    const ex = exMap.get(row.customer_id);
    if (!ex || ex.status === mapped) continue;
    const base = {
      id: ex.id,
      customer_id: ex.customer_id,
      customer_name: ex.customer_name || row.customer_name || null,
      fromStatus: ex.status,
    };
    if (mapped === "active") {
      out.push({ ...base, kind: "recover_notice", toStatus: null });
    } else if (mapped === "suspended") {
      out.push({ ...base, kind: "suspend", toStatus: "suspended" });
    } else {
      out.push({ ...base, kind: "cancel", toStatus: "cancelled" });
    }
  }
  return out;
}

const STATUS_LABEL: Record<string, string> = {
  active: "正常",
  suspended: "已被暂停（SUSPENDED）",
  cancelled: "已注销/关闭（CANCELLED）",
};

function beijingNow(): string {
  return new Date().toLocaleString("zh-CN", {
    timeZone: "Asia/Shanghai",
    month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false,
  });
}

/** 库级去重：24h（被停）/ 7 天（恢复提醒，问题未处理前每周提醒一次即可） */
async function isDuplicateNotice(key: string, hours: number): Promise<boolean> {
  const since = new Date(Date.now() - hours * 3600_000);
  const dup = await prisma.notifications.findFirst({
    where: { type: "alert", created_at: { gte: since }, metadata: { contains: key } },
    select: { id: true },
  });
  return !!dup;
}

export interface CidStatusSyncStats {
  updated: number;
  recoverNotices: number;
  alerted: number;
}

/**
 * 应用状态变化并告警（普通站内通知推归属人 + 飞书群按 MCC 汇总一条，非弹窗——07 q3=a）。
 * 永不抛异常（告警/写库失败不弄坏同步主流程，逐条隔离）。
 */
export async function applyCidStatusChanges(
  mcc: { id: bigint; mcc_id: string; mcc_name: string | null; user_id: bigint },
  changes: CidStatusChange[],
  log: (msg: string) => void,
): Promise<CidStatusSyncStats> {
  const stats: CidStatusSyncStats = { updated: 0, recoverNotices: 0, alerted: 0 };
  if (changes.length === 0) return stats;
  const label = mcc.mcc_name ? `${mcc.mcc_name}（${mcc.mcc_id}）` : mcc.mcc_id;

  const downLines: string[] = []; // 本轮真正新发现的被停/注销（去重后）
  const downKeys: string[] = [];
  const recoverLines: string[] = [];
  const recoverKeys: string[] = [];

  for (const c of changes) {
    const name = c.customer_name ? `${c.customer_name}(${c.customer_id})` : c.customer_id;
    if (c.kind === "recover_notice") {
      const key = `cid_status_${c.customer_id}_recovered`;
      try {
        if (!(await isDuplicateNotice(key, 7 * 24))) {
          recoverLines.push(`• ${name}：Google 侧已恢复为 ENABLED（库内仍为${STATUS_LABEL[c.fromStatus] || c.fromStatus}）`);
          recoverKeys.push(key);
        }
        stats.recoverNotices++;
      } catch (e) {
        log(`  [CID状态] 恢复提醒去重查询失败（跳过 ${name}）: ${e instanceof Error ? e.message.slice(0, 80) : e}`);
      }
      continue;
    }
    // suspend / cancel：写库（Google 真值跟随，与 D-248 口径一致）
    try {
      await prisma.mcc_cid_accounts.update({
        where: { id: c.id },
        data: {
          status: c.toStatus!,
          is_available: "D",
          status_changed_at: new Date(),
          last_synced_at: new Date(),
        },
      });
      stats.updated++;
      log(`  [CID状态] ${label} ${name}: ${c.fromStatus} → ${c.toStatus}（Sheet 状态列真值）`);
      const key = `cid_status_${c.customer_id}_${c.toStatus}`;
      if (!(await isDuplicateNotice(key, 24))) {
        downLines.push(`• ${name}：${STATUS_LABEL[c.fromStatus] || c.fromStatus} → ${STATUS_LABEL[c.toStatus!]}`);
        downKeys.push(key);
      }
    } catch (e) {
      log(`  [CID状态] 写库失败（跳过 ${name}）: ${e instanceof Error ? e.message.slice(0, 80) : e}`);
    }
  }

  // 站内通知（按 MCC 每轮各合并一条）+ 飞书群汇总
  try {
    const owner = await prisma.users.findFirst({
      where: { id: mcc.user_id, is_deleted: 0, status: "active" },
      select: { id: true },
    });
    const recipients = owner
      ? [owner.id]
      : (await prisma.users.findMany({
          where: { role: "admin", is_deleted: 0, status: "active" },
          select: { id: true },
        })).map((u) => u.id); // 归属人失效兜底发管理员，危险不静默（同 D-269 口径）

    if (downLines.length > 0 && recipients.length > 0) {
      const title = `你的 MCC ${label} 有 ${downLines.length} 个账户被 Google 停用`;
      const content =
        `统一脚本回传的账户状态显示以下账户已非正常状态（${beijingNow()} 北京时间发现）：\n` +
        downLines.join("\n") +
        `\n\n这些账户已在 CRM 标记为不可用（名下广告系列已锁操作）。若账户是因「广告主身份验证」逾期被停，请尽快到 Google Ads 后台完成验证。处理恢复后，到 MCC 管理点「同步 CID」确认恢复。`;
      const metadata = JSON.stringify({ keys: downKeys, kind: "cid_status_down" });
      await prisma.notifications.createMany({
        data: recipients.map((uid) => ({ user_id: uid, type: "alert", title, content, metadata })),
      });
      void sendAlert({ level: "warning", title, content: downLines.join("\n"), source: "cid-status-sync" });
      stats.alerted += downLines.length;
    }

    if (recoverLines.length > 0 && recipients.length > 0) {
      const title = `你的 MCC ${label} 有 ${recoverLines.length} 个被停账户在 Google 侧已恢复`;
      const content =
        `统一脚本回传的账户状态显示以下账户 Google 侧已是 ENABLED，但 CRM 内仍标记为被停（${beijingNow()} 北京时间发现）：\n` +
        recoverLines.join("\n") +
        `\n\n按规则系统不自动解锁（防误报洗白）。请人工核实后到 MCC 管理点「同步 CID」恢复。`;
      const metadata = JSON.stringify({ keys: recoverKeys, kind: "cid_status_recover" });
      await prisma.notifications.createMany({
        data: recipients.map((uid) => ({ user_id: uid, type: "alert", title, content, metadata })),
      });
      void sendAlert({ level: "info", title, content: recoverLines.join("\n"), source: "cid-status-sync" });
      stats.alerted += recoverLines.length;
    }
  } catch (e) {
    log(`  [CID状态] 告警发送失败（不影响主流程）: ${e instanceof Error ? e.message.slice(0, 100) : e}`);
  }

  return stats;
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
  /** D-277：按 Sheet 状态列真值更新的行数（被停/注销跟随） */
  statusUpdated: number;
  /** D-277：Google 已恢复但库内被停的提醒数（不动库） */
  recoverNotices: number;
  warnings: string[];
}

/** 每日执行入口（daily-sync Step 2.4 挂载）：逐 MCC 读 Sheet CID_List 并比对入库 */
export async function syncCidListFromSheets(log: (msg: string) => void): Promise<CidListSyncStats> {
  const stats: CidListSyncStats = { mccs: 0, skipped: 0, created: 0, renamed: 0, cancelled: 0, guardTriggered: 0, statusUpdated: 0, recoverNotices: 0, warnings: [] };

  const mccs = await prisma.google_mcc_accounts.findMany({
    where: { is_deleted: 0, sheet_url: { not: null } },
    select: { id: true, mcc_id: true, mcc_name: true, sheet_url: true, user_id: true },
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
      // 数据真实性规范：只写标识字段，可用性 U（未核实）等状态同步核实后转 Y/N。
      // D-277：新脚本带状态列时按 Google 真值登记（非 ENABLED 直接标停 + D 禁选）。
      const mapped = mapSheetStatus(row.google_status);
      const initialStatus = mapped ?? "active";
      await prisma.mcc_cid_accounts.create({
        data: {
          mcc_account_id: mcc.id,
          customer_id: row.customer_id,
          customer_name: row.customer_name || null,
          is_available: initialStatus === "active" ? "U" : "D",
          status: initialStatus,
          status_changed_at: initialStatus === "active" ? null : new Date(),
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

    // D-277：状态列真值跟随（老脚本无状态列时 diffCidStatuses 天然为空，零行为变化）
    const statusChanges = diffCidStatuses(sheetRows, existing);
    if (statusChanges.length > 0) {
      const s = await applyCidStatusChanges(
        { id: mcc.id, mcc_id: mcc.mcc_id, mcc_name: mcc.mcc_name, user_id: mcc.user_id },
        statusChanges,
        log,
      );
      stats.statusUpdated += s.updated;
      stats.recoverNotices += s.recoverNotices;
    }

    if (diff.create.length || diff.cancel.length || diff.rename.length || statusChanges.length) {
      log(`  [CID_List] ${label}: Sheet ${sheetRows.length} 个 CID，新增 ${diff.create.length}、改名 ${diff.rename.length}、取消 ${diff.cancel.length}${diff.presentButDisabled ? `、停用在列不复活 ${diff.presentButDisabled}` : ""}${statusChanges.length ? `、状态变化 ${statusChanges.length}` : ""}`);
    }
  }

  log(`  [CID_List] 完成：比对 ${stats.mccs} 个 MCC（跳过 ${stats.skipped}），新增 ${stats.created}、改名 ${stats.renamed}、取消 ${stats.cancelled}${stats.statusUpdated ? `、状态跟随 ${stats.statusUpdated}` : ""}${stats.recoverNotices ? `、待人工恢复提醒 ${stats.recoverNotices}` : ""}${stats.guardTriggered ? `、缩水保护触发 ${stats.guardTriggered}` : ""}`);
  return stats;
}

/**
 * D-277 半小时级入口（today-merchants-sync cron 挂载）：只比对状态列，不做建号/销号
 * （建号/销号仍由每日 06:00 主同步负责——半小时轮追求的是「账户被停尽快发现」）。
 * 老脚本（无 Status 列）的 MCC 自动跳过，逐 MCC 失败隔离。
 */
export async function syncCidStatusesFromSheets(log: (msg: string) => void): Promise<{
  mccs: number;
  withStatusCol: number;
  updated: number;
  recoverNotices: number;
}> {
  const out = { mccs: 0, withStatusCol: 0, updated: 0, recoverNotices: 0 };
  const mccs = await prisma.google_mcc_accounts.findMany({
    where: { is_deleted: 0, sheet_url: { not: null } },
    select: { id: true, mcc_id: true, mcc_name: true, sheet_url: true, user_id: true },
  });
  out.mccs = mccs.length;

  for (const mcc of mccs) {
    try {
      const sid = extractSheetId(mcc.sheet_url || "");
      if (!sid) continue;
      const rows = await readSheetCsv(sid, "CID_List");
      const sheetRows = parseCidListRows(rows);
      if (!sheetRows || sheetRows.length === 0) continue;
      if (!sheetRows.some((r) => r.google_status != null)) continue; // 老脚本无状态列
      out.withStatusCol++;

      const existing = await prisma.mcc_cid_accounts.findMany({
        where: { mcc_account_id: mcc.id, is_deleted: 0 },
        select: { id: true, customer_id: true, customer_name: true, status: true },
      });
      const changes = diffCidStatuses(sheetRows, existing);
      if (changes.length === 0) continue;
      const s = await applyCidStatusChanges(
        { id: mcc.id, mcc_id: mcc.mcc_id, mcc_name: mcc.mcc_name, user_id: mcc.user_id },
        changes,
        log,
      );
      out.updated += s.updated;
      out.recoverNotices += s.recoverNotices;
    } catch (e) {
      // 拉取失败（含被封）不在这里报警——被封告警由 broadcastSheetFailure 通道负责，避免双报
      log(`  [CID状态] ${mcc.mcc_name || mcc.mcc_id}: 本轮跳过（${e instanceof Error ? e.message.slice(0, 100) : e}）`);
    }
  }
  return out;
}
