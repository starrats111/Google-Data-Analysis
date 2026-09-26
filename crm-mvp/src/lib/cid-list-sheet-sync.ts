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
 *   所以「出现在 Sheet」不能当 ENABLED 证据 → 本同步的**名单比对路径**（diffCidList）
 *   【绝不】把 suspended/cancelled 行自动复活成 active（否则 D-248 被中止锁操作会被洗白）。
 *   D-324：复活改由**状态列路径**（diffCidStatuses）负责，判据是 Status 列的
 *   customer_client.status 真值 = ENABLED，与「在不在表里」无关，见下方 D-324 段。
 * - 消失判定与 API 口径一致：active 行不在 Sheet → status=cancelled + is_available=D。
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
  /** D-359：表头吞掉了开头若干行（解析结果缺行）→ 本轮跳过取消 */
  cancelSkippedByHeaderGap: boolean;
}

export interface ExistingCidRow {
  id: bigint;
  customer_id: string;
  customer_name: string | null;
  status: string;
}

/**
 * 表头列定位。
 *
 * D-353（2026-09-23 实测）：部分 MCC 的 CID_List 表头单元格被合并，gviz 导出的第一行
 * 变成「列名 + 被吞进来的前若干行值」，例：
 *   "CustomerID 127-352-0631 130-586-4419 …","AccountName ","Status ENABLED CANCELED …"
 * 精确 indexOf 匹配不上 → parseCidListRows 整表判 null → 两条 Sheet 同步路径静默跳过
 * 该 MCC，库内 CID 状态从此永久冻结（wj11 / MCC 133 的 5664598997 已注销却仍 active，
 * 页面显示「已启用」且任何启停都报 USER_PERMISSION_DENIED）。
 * 体检结果：60 个配了 Sheet 的 MCC 里 25 个判 null，其中 5 个是这一类表头合并。
 *
 * 退化规则只认「首段等于列名」，不做宽松的 includes/startsWith——
 * 后者会让 "statuschangedat" 之类的列名误命中 "status"。
 *
 * D-359 更正 D-352 的一句话：「被吞的只是列名单元格本身，数据行完整」是错的。
 * 被吞进表头的那几行**不会再出现在数据区**（见 countAbsorbedHeaderRows）。
 */
function findHeaderCol(hdr: string[], want: string): number {
  const exact = hdr.indexOf(want);
  if (exact >= 0) return exact;
  return hdr.findIndex((h) => h.split(/[\s\r\n]+/)[0] === want);
}

/**
 * D-359（2026-09-26 实测）：表头吞行检测——返回被吞进列名单元格的数据行数（0 = 表头干净）。
 *
 * 机理：gviz 的 `tqx=out:csv` 自己猜表头行数（headers=-1）。CID_List 三列全是文本时，
 * 它会把开头若干**数据行**一并认成多行表头，按列用空格拼进列名单元格：
 *   "CustomerID 127-352-0631 130-586-4419 …","AccountName ","Status ENABLED ENABLED …"
 * 这些行从此不在数据区。D-352 让这种表头能认出列位置（此前整表判 null 被跳过），
 * 代价是解析结果**缺开头那几十行**——而「不在 Sheet 里的 active 行」正是 diffCidList
 * 判取消的依据，于是这批 CID 被自动标 cancelled + is_available=D，
 * 展示层按 D-248 直接显示「所属 CID 已被 Google 中止，无法操作」。
 *
 * 实证（D-352 上线后三天）：MCC 133/123/167 共 5 个 CID 被误判中止，
 * Sheet 的 Status 列其实全是 ENABLED；其中 133 的 127-352-0631 名下 855-MUI3-LittleEnglish
 * 还在投——D-330 的孤儿回停只改库不动 Google，于是广告照常花钱、CRM 显示已暂停且锁操作。
 * 全库扫描：60 个配 Sheet 的 MCC 中 5 个有吞行（吞 1/3/7/12/18 行），误判仅此 5 条。
 *
 * 根治在取数侧（readSheetCsv 的 gviz URL 带 headers=1，强制只认第一行当表头，实测
 * 同一张表从 62 行恢复成 80 行）；本函数是第二道闸：列名后面还跟着值 = 本轮解析**缺行**，
 * 缺行的表不配判「消失即取消」。空名字不会各留一个空格（实测 "AccountName " 只有一个
 * 尾空格），所以无法靠 token 数把缺的行还原出来——只能识别缺、不能补齐。
 */
export function countAbsorbedHeaderRows(rows: string[][]): number {
  if (rows.length === 0) return 0;
  const hdr = rows[0].map((h) => h.trim());
  const ci = findHeaderCol(hdr.map((h) => h.toLowerCase()), "customerid");
  if (ci < 0) return 0;
  // 只数长得像 CID 的段（≥8 位数字），免得「Customer ID」这类带空格的列名被误判成吞行
  return (hdr[ci] ?? "")
    .split(/[\s\r\n]+/)
    .slice(1)
    .filter((t) => t.replace(/\D/g, "").length >= 8).length;
}

/** Sheet CID_List 表头解析：返回 null 表示表头不符（老脚本/别的格式），调用方跳过 */
export function parseCidListRows(rows: string[][]): CidListRow[] | null {
  if (rows.length === 0) return null;
  const hdr = rows[0].map((h) => h.trim().toLowerCase());
  const ci = findHeaderCol(hdr, "customerid");
  const ni = findHeaderCol(hdr, "accountname");
  const si = findHeaderCol(hdr, "status"); // D-277 可选列：缺列=老脚本，google_status 全 null
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
// Sheet Status 列 = Google 账户状态真值 → 库内 status 跟随。
//
// D-324（2026-09-06 改判）：原来「只自动停不自动恢复」（q5=b），恢复只发提醒等人点
// 「同步 CID」按钮。那条规矩的依据是 D-277 之前的口径——Ads Script 的 accounts()
// 迭代器不过滤账号状态，「出现在 Sheet」不能当 ENABLED 证据。但 D-277 已经加了
// Status 列（GAQL customer_client.status 原值），停用方向正是拿它直接写库标停的；
// 同一列报 ENABLED 却不敢写回，是不对称。后果：账户申诉回来后库内一直锁着，
// 只能等商家找上门（670-967-7594 停于 09-02、Google 侧早已恢复，到 09-06 仍显示已停用）。
// 现改为：Status 列明确为 ENABLED 且库内被停 → 自动恢复 active + 解除 D，照发通知。
// 判据仍只认 Status 列真值（mapSheetStatus 返回 null 的一律不动库），不靠「在不在表里」。
// ─────────────────────────────────────────────────────────────

/** Google customer_client.status → 库内 status 三态；不确定值（UNKNOWN/空）返回 null 不动库 */
export function mapSheetStatus(raw: string | null | undefined): "active" | "suspended" | "cancelled" | null {
  const s = (raw || "").trim().toUpperCase();
  if (s === "ENABLED") return "active";
  if (s === "SUSPENDED") return "suspended";
  if (s === "CANCELED" || s === "CANCELLED" || s === "CLOSED") return "cancelled";
  return null;
}

export type CidStatusChangeKind = "suspend" | "cancel" | "recover";

export interface CidStatusChange {
  kind: CidStatusChangeKind;
  id: bigint;
  customer_id: string;
  customer_name: string | null;
  fromStatus: string;
  /** suspend→suspended / cancel→cancelled / recover→active（D-324 起恢复也写库） */
  toStatus: "suspended" | "cancelled" | "active";
}

/**
 * 纯 diff（可单测）：Sheet 状态列 vs 库内 status。
 * - 库内 active，Sheet SUSPENDED/CANCELED → 自动标停（suspend/cancel）
 * - 库内 suspended ↔ cancelled 之间变化 → 跟随 Google 真值更新
 * - 库内被停，Sheet ENABLED → recover（D-324：跟随真值恢复 active + 解除 D，并发通知）
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
      out.push({ ...base, kind: "recover", toStatus: "active" });
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
  /** D-324：真正写库恢复的条数（原 recoverNotices 只是「提醒了几条」） */
  recovered: number;
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
  const stats: CidStatusSyncStats = { updated: 0, recovered: 0, alerted: 0 };
  if (changes.length === 0) return stats;
  const label = mcc.mcc_name ? `${mcc.mcc_name}（${mcc.mcc_id}）` : mcc.mcc_id;

  const downLines: string[] = []; // 本轮真正新发现的被停/注销（去重后）
  const downKeys: string[] = [];
  const recoverLines: string[] = [];
  const recoverKeys: string[] = [];

  for (const c of changes) {
    const name = c.customer_name ? `${c.customer_name}(${c.customer_id})` : c.customer_id;
    if (c.kind === "recover") {
      // D-324：Status 列真值 ENABLED → 写库恢复。必须连 is_available 一起解除 D，
      // 只改 status 的话展示层照样按 D 显示「已停用」并禁选（这就是原来点了
      // 「同步 CID」也解不开锁的那个洞）。恢复后可用性未核实 → U，等计数转 Y/N。
      const key = `cid_status_${c.customer_id}_recovered`;
      try {
        await prisma.mcc_cid_accounts.update({
          where: { id: c.id },
          data: {
            status: "active",
            is_available: "U",
            status_changed_at: new Date(),
            last_synced_at: new Date(),
          },
        });
        stats.recovered++;
        log(`  [CID状态] ${label} ${name}: ${c.fromStatus} → active（Sheet 状态列真值，已解除 D）`);
        if (!(await isDuplicateNotice(key, 7 * 24))) {
          recoverLines.push(`• ${name}：${STATUS_LABEL[c.fromStatus] || c.fromStatus} → 正常（Google 侧已恢复 ENABLED）`);
          recoverKeys.push(key);
        }
      } catch (e) {
        log(`  [CID状态] 恢复写库失败（跳过 ${name}）: ${e instanceof Error ? e.message.slice(0, 80) : e}`);
      }
      continue;
    }
    // suspend / cancel：写库（Google 真值跟随，与 D-248 口径一致）
    try {
      await prisma.mcc_cid_accounts.update({
        where: { id: c.id },
        data: {
          status: c.toStatus,
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

  // ── D-330：本轮被标 suspended/cancelled 的 CID，旗下在投系列立即回停 ──
  // 账户已死，其系列不可能在投；且撤销后它们永久从 Sheet CampaignInfo 消失，
  // Sheet 驱动的状态同步会永久跳过它们（状态冻结在 active+ENABLED，人点同步也没用）。
  if (changes.some((c) => c.kind !== "recover")) {
    try {
      const { reconcileOrphanCampaignsForSuspendedCids } = await import("@/lib/google-ads/orphan-campaign-reconcile");
      const orphan = await reconcileOrphanCampaignsForSuspendedCids({ userId: mcc.user_id, mccIds: [mcc.id] });
      if (orphan.paused > 0 || orphan.aligned > 0) {
        log(
          `  [CID状态] D-330 回停被中止 CID 旗下在投系列 ${orphan.paused} 个` +
          `${orphan.aligned > 0 ? `，拉平内部状态 ${orphan.aligned} 个` : ""}`,
        );
      }
    } catch (e) {
      log(`  [CID状态] D-330 孤儿系列回停失败: ${e instanceof Error ? e.message.slice(0, 80) : e}`);
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
      const title = `你的 MCC ${label} 有 ${recoverLines.length} 个被停账户已恢复可用`;
      const content =
        `统一脚本回传的账户状态显示以下账户 Google 侧已是 ENABLED（${beijingNow()} 北京时间发现）：\n` +
        recoverLines.join("\n") +
        `\n\nCRM 已按真值自动解锁，这些 CID 现在可以正常选号建广告，无需再手动点「同步 CID」。`;
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
 *
 * ─────────────────────────────────────────────────────────────
 * D-330（2026-09-14）：上面这条佐证会和状态同步形成**循环依赖死锁**。
 * 实证：jymcc 的 CID 1377549607 自 08-13 起卡死一个月，日志每天报
 * 「不在 Sheet 但名下仍有 ENABLED 系列…不自动取消」。
 *   - CID 不在 CID_List → 本该标 cancelled，但名下有 ENABLED 系列 → 被本守卫拦住
 *   - 那条系列还是 ENABLED，是因为它不在 CampaignInfo 里 → 状态同步 `!sheetRow continue` 跳过
 *   两个守卫各自把对方的过期值当证据，谁都不先动，人点多少次同步都无效。
 *
 * 破解：引入第三方证据 cidsInCampaignInfo（CampaignInfo tab 里出现过的 CID）。
 * 同一张 Sheet 的两个 tab 由同一脚本同轮生成，若某 CID 在**两个 tab 里同时缺席**，
 * 那就是「该账户已不在此 MCC 下」的独立佐证——此时「名下还有 ENABLED 系列」不是取消的
 * 反证，恰恰是那批因跳过而冻结的脏数据，继续拦只会让死锁永续。
 * 仅当 CampaignInfo 可读时才启用该判据（传 undefined = 拿不到，退回旧的保守行为）。
 * ─────────────────────────────────────────────────────────────
 */
export function diffCidList(
  sheetRows: CidListRow[],
  existing: ExistingCidRow[],
  enabledCids: Set<string> = new Set(),
  cidsInCampaignInfo?: Set<string>,
  opts: { absorbedHeaderRows?: number } = {},
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
      // 出现在 Sheet ≠ ENABLED（迭代器不过滤状态），这条路径永不复活；
      // 复活只认 Status 列真值，走 diffCidStatuses 的 recover（D-324）
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
  // D-359：表头吞行 ⟹ 解析结果开头缺了若干行，「不在 Sheet 里」不成立，整轮不取消。
  // 缩水保护拦不住它：18/80 行的缺口既不到 50% 门槛，缺的又不是尾部而是开头。
  const cancelSkippedByHeaderGap = (opts.absorbedHeaderRows ?? 0) > 0;

  const cancel: Array<{ id: bigint; customer_id: string }> = [];
  const cancelBlocked: Array<{ id: bigint; customer_id: string }> = [];
  if (!cancelSkippedByGuard && !cancelSkippedByHeaderGap) {
    for (const ex of missingActive) {
      // D-330：ENABLED 佐证只在「该 CID 的系列确实还出现在 CampaignInfo 里」时才成立。
      // 两个 tab 同时缺席 ⟹ 账户已不在此 MCC 下，库内那批 ENABLED 是被跳过的冻结值，
      // 不能再当作「还在投」的证据（否则与状态同步互相锁死，见函数头注释）。
      //
      // D-359 收紧：CampaignInfo 可读时，判据从「库内 ENABLED 且在 CampaignInfo」
      // 改成「在 CampaignInfo」即可拦。两个 tab 由同一脚本同轮生成，系列还被报上来
      // ⟹ 该账户仍挂在本 MCC 下，与「从 CID_List 消失」直接矛盾——此时取消只可能是
      // CID_List 那一侧丢了数据（吞行/半写表/串列），而库内 google_status 是过期快照，
      // 拿它当唯一判据等于让一个陈旧字段决定要不要锁死一个活账户。D-359 的 5 条误判里
      // 有 3 条正是「库内没有 ENABLED 系列、但 CampaignInfo 里还在」而被放行取消的。
      // 拿不到 CampaignInfo（undefined）时退回 D-330 的旧判据，不放宽也不收紧。
      const blocked = cidsInCampaignInfo
        ? cidsInCampaignInfo.has(ex.customer_id)
        : enabledCids.has(ex.customer_id);
      if (blocked) {
        cancelBlocked.push({ id: ex.id, customer_id: ex.customer_id });
      } else {
        cancel.push({ id: ex.id, customer_id: ex.customer_id });
      }
    }
  }

  return { create, rename, cancel, cancelBlocked, presentButDisabled, cancelSkippedByGuard, cancelSkippedByHeaderGap };
}

export interface CidListSyncStats {
  mccs: number;
  skipped: number;
  created: number;
  renamed: number;
  cancelled: number;
  guardTriggered: number;
  /** D-359：表头吞行导致本轮跳过取消的 MCC 数 */
  headerGapTriggered: number;
  /** D-277：按 Sheet 状态列真值更新的行数（被停/注销跟随） */
  statusUpdated: number;
  /** D-324：Google 侧已恢复 ENABLED、自动写库解锁的行数（原为「只提醒」计数） */
  recovered: number;
  warnings: string[];
}

/** 每日执行入口（daily-sync Step 2.4 挂载）：逐 MCC 读 Sheet CID_List 并比对入库 */
export async function syncCidListFromSheets(log: (msg: string) => void): Promise<CidListSyncStats> {
  const stats: CidListSyncStats = { mccs: 0, skipped: 0, created: 0, renamed: 0, cancelled: 0, guardTriggered: 0, headerGapTriggered: 0, statusUpdated: 0, recovered: 0, warnings: [] };

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
      // D-353：这里原来静默 continue，是最贵的一条。CID 状态同步整轮不跑却零日志，
      // 只能靠「某个 CID 状态为什么几个月不动」反查才发现（wj11 那次冻了三个月）。
      // 打上表头首段，好判是老格式（无 CustomerID 列）还是表头被合并/残表。
      log(`  [CID_List] ${label}: CID_List 解析不出有效行，跳过（raw=${rows.length} 行，表头=${JSON.stringify(rows[0]?.slice(0, 4).map((c) => c.split(/[\s\r\n]+/)[0]) ?? [])}）`);
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

    // D-330 破死锁用的第三方证据：CampaignInfo tab 里出现过的 CID 集合。
    // 读失败/无该 tab → undefined，diffCidList 退回旧的保守行为（宁可不取消）。
    let cidsInCampaignInfo: Set<string> | undefined;
    try {
      const { readCampaignInfoStatuses } = await import("@/lib/sheet-status-sync");
      const infoMap = await readCampaignInfoStatuses(mcc.sheet_url);
      if (infoMap) {
        const s = new Set<string>();
        for (const v of infoMap.values()) {
          if (v.customerId) s.add(v.customerId.replace(/\D/g, ""));
        }
        // 空集合说明 CampaignInfo 无 CustomerId 列（老脚本），不能当证据用
        if (s.size > 0) cidsInCampaignInfo = s;
      }
    } catch {
      // 忽略：拿不到就退回旧行为
    }

    const absorbed = countAbsorbedHeaderRows(rows); // D-359：gviz 把开头几行吞进表头了
    const diff = diffCidList(sheetRows, existing, enabledCids, cidsInCampaignInfo, {
      absorbedHeaderRows: absorbed,
    });
    stats.mccs++;

    if (diff.cancelSkippedByHeaderGap) {
      stats.headerGapTriggered++;
      const w = `${label}: CID_List 表头吞掉了开头 ${absorbed} 行数据（gviz 多行表头误判），`
        + `本轮解析到的 ${sheetRows.length} 行是残缺的——只登记新增/改名/跟状态，跳过取消，请复核脚本表头`;
      stats.warnings.push(w);
      log(`  [CID_List] ⚠️ ${w}`);
    }

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
      // D-330：能走到这里说明该 CID 的系列仍在 CampaignInfo 里 → 确实是「隐藏」而非撤销，
      // 保持只告警。两个 tab 同时缺席的那批已在 diff 里改判为 cancel，不再进这个分支。
      const w = `${label}: ${diff.cancelBlocked.length} 个 CID 不在 CID_List 但名下仍有 ENABLED 系列且系列仍在 CampaignInfo（判定为被 MCC「隐藏」），不自动取消：${diff.cancelBlocked.map((c) => c.customer_id).join("/")}`;
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
      stats.recovered += s.recovered;
    }

    if (diff.create.length || diff.cancel.length || diff.rename.length || statusChanges.length) {
      log(`  [CID_List] ${label}: Sheet ${sheetRows.length} 个 CID，新增 ${diff.create.length}、改名 ${diff.rename.length}、取消 ${diff.cancel.length}${diff.presentButDisabled ? `、停用在列不复活 ${diff.presentButDisabled}` : ""}${statusChanges.length ? `、状态变化 ${statusChanges.length}` : ""}`);
    }
  }

  log(`  [CID_List] 完成：比对 ${stats.mccs} 个 MCC（跳过 ${stats.skipped}），新增 ${stats.created}、改名 ${stats.renamed}、取消 ${stats.cancelled}${stats.statusUpdated ? `、状态跟随 ${stats.statusUpdated}` : ""}${stats.recovered ? `、自动恢复 ${stats.recovered}` : ""}${stats.guardTriggered ? `、缩水保护触发 ${stats.guardTriggered}` : ""}${stats.headerGapTriggered ? `、表头吞行跳过取消 ${stats.headerGapTriggered}` : ""}`);
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
  recovered: number;
  /** D-353：CID_List 解析不出有效行的 MCC 数（表头合并/老格式/残表）——这些 MCC 本轮状态同步等于没跑 */
  unparsable: number;
  /** D-359：表头吞掉开头若干行的 MCC 数——这些 MCC 的状态同步漏掉了被吞那几十个 CID */
  headerGap: number;
}> {
  const out = { mccs: 0, withStatusCol: 0, updated: 0, recovered: 0, unparsable: 0, headerGap: 0 };
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
      // D-353：只计数不逐 MCC 打日志——这条半小时跑一轮 × 60 个 MCC，逐条会把日志冲掉；
      // 汇总数字由调用方打一行，异常值（如 25/60）就是「大批 MCC 状态同步实际没跑」的信号。
      if (!sheetRows || sheetRows.length === 0) { out.unparsable++; continue; }
      // D-359：吞行只会让这几十个 CID 本轮没被核对（状态停在旧值），不会写错——
      // 这条路径只按解析到的行更新状态，不做「消失即取消」。计数是为了让漏核对可见。
      if (countAbsorbedHeaderRows(rows) > 0) out.headerGap++;
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
      out.recovered += s.recovered;
    } catch (e) {
      // 拉取失败（含被封）不在这里报警——被封告警由 broadcastSheetFailure 通道负责，避免双报
      log(`  [CID状态] ${mcc.mcc_name || mcc.mcc_id}: 本轮跳过（${e instanceof Error ? e.message.slice(0, 100) : e}）`);
    }
  }
  return out;
}
