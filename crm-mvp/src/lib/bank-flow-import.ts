/**
 * D-279 银行流水导入财务月表 — xls 解析 + 金额比对匹配引擎（纯函数，路由负责取数）
 *
 * 07 拍板口径（2026-08-25）：按金额比对认账，不依赖表格里的平台标注（标注只做辅助校验）；
 * 必须覆盖「多人打款合并成 1-2 笔到账」与「一批打款拆成多笔到账」（WISE 实测拆 5 笔）。
 *
 * 匹配模型：
 * - 候选池 = 该收款卡名下、到账日 ±WINDOW_DAYS 内全部平台的逐笔打款单（折 CNY，
 *   归属口径与 prefill/candidates 完全一致：月快照文本匹配 + C-179 逐笔修正 + payment_no 去重）；
 * - 单笔到账 = 池内任意子集（子集恰为整批 → L1；跨平台/跨批组合 → L2；批内部分人 → L3），
 *   统一用一个带容差的子集和搜索覆盖；
 * - 多笔到账 = 一个批次（L4，WISE 拆分场景）：同卡 2~N 笔到账合计 ≈ 某批次该卡份额；
 * - 全局一致性分配：候选按费率升序认领，每笔打款单只能被消费一次、每笔到账只归一个条目
 *   （实测教训：贪心不排序会把 ¥29,855.87 错配进 PM 批次，拆散真正的 CG 组合）；
 * - 手续费率容差 [FEE_MIN, FEE_MAX]（实测 WISE 大额批费率 2.08%，故上限 2.5%）；
 *   费率 >REVIEW_FEE 的命中标 review，绝不静默；
 * - 对不上的行如实返回 unmatched，不猜着入账（数据真实性规范）。
 *
 * D-290（07 2026-08-27 拍板）三项补充：
 * - 工作簿里「按投手分摊」的那张明细表（投手/汇率两列都填满）不是银行流水，解析成 detail sheet 不参与匹配
 *   （实证：2-5 月工作簿第一张 351.09011 与真表 351.14 只差几分钱，混进来会串账）；
 * - 既有条目登记日与银行差 ≤DATE_FIX_MAX_DAYS 天 → 出「校正到账日」提案，差更多 → 保留现值只跳过；
 * - 银行分多笔到账、合计等于某个既有条目时：WISE 卡是「平台一笔打款、我们分批回款」保持一条不拆；
 *   其余（平台自己分开汇款，如 PM）按明细净额把人精确落到各笔上，出「按银行拆分」提案，
 *   落不到人就如实跳过请人工处理，绝不按比例硬摊。
 */

export const IMPORT_WINDOW_DAYS = 14;
/** 一批拆多笔时，各笔到账日与批次日的最大距离（WISE 实测 6/12 批拖到 6/24 才到最后一笔） */
export const SPLIT_WINDOW_DAYS = 14;
/**
 * 补捞窗口（07 2026-08-26 拍板）：表格日期可能写错（实证：月表把 03-04 到账写成 02-12，
 * 早于打款日 20 天），常规窗口没对上的行放宽到此窗口再捞一遍；
 * 捞到的入账日按库内打款日（不是表格日期），必标 review 请 07 复核。
 */
export const RESCUE_WINDOW_DAYS = 45;
/**
 * D-290（07 2026-08-27 拍板）：既有条目的登记日与银行流水相差 ≤5 天的以银行为准（给校正提案），
 * 差太多的以实际到账时间为准（保留库内现值，只跳过）——实证 3/19 那三笔表格写错，实际 3/31 到账。
 */
export const DATE_FIX_MAX_DAYS = 5;
const FEE_MIN = -0.0015; // 汇差可造成轻微负手续费（D-274 实证 −0.03%）
const FEE_MAX = 0.025;
const REVIEW_FEE = 0.015;
/** 子集和搜索节点预算（防病态输入拖死请求） */
const DFS_BUDGET = 300000;

const r2 = (n: number) => Math.round(n * 100) / 100;
const DAY = 86400000;
const daysBetween = (a: string, b: string) => Math.abs(Date.parse(a) - Date.parse(b)) / DAY;
/** 有符号天数差：a 比 b 晚多少天（正 = a 在 b 之后） */
const signedDays = (a: string, b: string) => (Date.parse(a) - Date.parse(b)) / DAY;

// ── xls 解析 ─────────────────────────────────────────────────────────────────

export interface ParsedBankRow {
  /** 行唯一键：sheet 内序号 */
  key: string;
  sheet: string;
  /** 表内行号（1 起，含表头），报错/预览定位用 */
  rowNo: number;
  date: string; // YYYY-MM-DD
  payee: string;
  /** 收款人账号列原文（卡号数字 或 恒生/汇丰 等渠道名） */
  acct: string;
  /** 人民币到账金额（与 usd 互斥） */
  cny: number | null;
  /** 美金到账金额（恒生/汇丰等美金账户） */
  usd: number | null;
  /** 该行金额列之外的全部标注文本（平台标注等，仅辅助校验） */
  note: string;
}

export interface ParsedSheet {
  name: string;
  rows: ParsedBankRow[];
  /** 无法解析成到账行的非空行数（合计行/散落备注等，正常现象） */
  skipped: number;
  /**
   * D-290：flow = 银行流水表；detail = 按投手分摊的明细表（不是银行到账，不参与匹配）。
   * 判据见 DETAIL_COL_RATIO。
   */
  kind: "flow" | "detail";
  /** detail 时的判定说明（预览里告诉 07 为什么跳过这张） */
  detailReason?: string;
}

/** 「投手」「汇率」列在多数行都有值 → 这张是按人分摊的明细表，不是银行流水 */
const DETAIL_COL_RATIO = 0.6;

const parseNum = (s: unknown): number | null => {
  const v = parseFloat(String(s ?? "").replace(/[,\s￥¥$]/g, ""));
  return isFinite(v) && v > 0 ? v : null;
};

/**
 * 解析财务月表的一个 sheet。表头行按列名定位（序号/时间/收款人户名/收款人账号/美金/人民币），
 * 财务手工表列数月月不同，只认列名不认列号。日期 M/D/YY；年份异常（如 5/22/22 笔误）归并到
 * sheet 内出现最多的年份。
 */
export function parseBankSheet(name: string, data: unknown[][]): ParsedSheet | null {
  if (!data || data.length < 2) return null;
  // 表头行：出现「时间」和「户名」类列名的第一行
  let headIdx = -1;
  let cols: { date: number; payee: number; acct: number; usd: number; cny: number; dealer: number; rate: number } | null = null;
  for (let i = 0; i < Math.min(data.length, 5); i++) {
    const row = (data[i] || []).map((c) => String(c ?? "").trim());
    const date = row.findIndex((c) => c.includes("时间") || c.includes("日期"));
    const payee = row.findIndex((c) => c.includes("户名"));
    if (date < 0 || payee < 0) continue;
    const acct = row.findIndex((c) => c.includes("账号"));
    const usd = row.findIndex((c) => c.includes("美金") || c.toUpperCase().includes("USD"));
    const cny = row.findIndex((c) => c.includes("人民币") || c.toUpperCase().includes("CNY"));
    headIdx = i;
    cols = {
      date, payee, acct, usd, cny,
      dealer: row.findIndex((c) => c.includes("投手")),
      rate: row.findIndex((c) => c.includes("汇率")),
    };
    break;
  }
  if (headIdx < 0 || !cols || cols.cny < 0) return null;

  interface RawRow { rowNo: number; m: number; d: number; y: number; payee: string; acct: string; cny: number | null; usd: number | null; note: string }
  const raw: RawRow[] = [];
  let skipped = 0;
  // D-290：按投手分摊的明细表判据 —— 到账行里「投手」「汇率」有值的比例
  let dealerFilled = 0;
  let rateFilled = 0;
  for (let i = headIdx + 1; i < data.length; i++) {
    const row = data[i] || [];
    const dateMatch = String(row[cols.date] ?? "").trim().match(/^(\d{1,2})\/(\d{1,2})\/(\d{2,4})$/);
    const payee = String(row[cols.payee] ?? "").trim();
    const cny = parseNum(row[cols.cny]);
    const usd = cols.usd >= 0 ? parseNum(row[cols.usd]) : null;
    if (!dateMatch || !payee || (cny == null && usd == null)) {
      if (row.some((c) => c != null && String(c).trim() !== "")) skipped++;
      continue;
    }
    // 金额列之外的文本全部收进 note（平台标注位置月月漂移，只能全收）
    const amountCols = new Set([cols.date, cols.payee, cols.acct, cols.usd, cols.cny]);
    const note = row
      .map((c, idx) => ({ c, idx }))
      .filter(({ c, idx }) => !amountCols.has(idx) && c != null && String(c).trim() !== "")
      .map(({ c }) => String(c).trim())
      .filter((t) => !/^[\d,.\s]+$/.test(t)) // 纯数字（右侧合计等散落数字）不进标注
      .join(" / ");
    if (cols.dealer >= 0 && String(row[cols.dealer] ?? "").trim() !== "") dealerFilled++;
    if (cols.rate >= 0 && String(row[cols.rate] ?? "").trim() !== "") rateFilled++;
    raw.push({
      rowNo: i + 1,
      m: parseInt(dateMatch[1], 10),
      d: parseInt(dateMatch[2], 10),
      y: parseInt(dateMatch[3], 10) % 100,
      payee,
      acct: cols.acct >= 0 ? String(row[cols.acct] ?? "").trim() : "",
      cny: cny != null ? cny : null,
      usd: cny == null ? usd : null, // 人民币列有值时以人民币为准
      note,
    });
  }
  if (raw.length === 0) return null;

  // 年份笔误归并：取众数年
  const yearCount = new Map<number, number>();
  for (const r of raw) yearCount.set(r.y, (yearCount.get(r.y) ?? 0) + 1);
  const modeYear = [...yearCount.entries()].sort((a, b) => b[1] - a[1])[0][0];

  const rows: ParsedBankRow[] = raw.map((r, i) => ({
    key: `${name}#${i}`,
    sheet: name,
    rowNo: r.rowNo,
    date: `${2000 + modeYear}-${String(r.m).padStart(2, "0")}-${String(r.d).padStart(2, "0")}`,
    payee: r.payee,
    acct: r.acct,
    cny: r.cny,
    usd: r.usd,
    note: r.note,
  }));

  // D-290：投手/汇率填满的是财务按人分摊的推导表（金额与真实到账差几分钱），不是银行流水
  const dealerRatio = dealerFilled / raw.length;
  const rateRatio = rateFilled / raw.length;
  if (dealerRatio >= DETAIL_COL_RATIO || rateRatio >= DETAIL_COL_RATIO) {
    const why = dealerRatio >= DETAIL_COL_RATIO
      ? `「投手」列 ${dealerFilled}/${raw.length} 行有值`
      : `「汇率」列 ${rateFilled}/${raw.length} 行有值`;
    return { name, rows, skipped, kind: "detail", detailReason: `${why}，判定为按人分摊的明细表，不参与流水匹配` };
  }
  return { name, rows, skipped, kind: "flow" };
}

// ── 收款卡归属 ────────────────────────────────────────────────────────────────

export interface ImportMethod {
  id: string;
  payeeName: string;
  payChannel: string;
  cardNo: string;
}

const normDigits = (s: string) => (s || "").replace(/\D/g, "");
const normText = (s: string) => (s || "").replace(/（/g, "(").replace(/）/g, ")").replace(/\s/g, "");

/**
 * 户名别名映射（07 2026-08-26 拍板）：月表里「龚建成-恒生」实际就是系统里「张文俊-香港」这张卡。
 * 命中别名的行直接归属到目标收款方式，不再走通用匹配。
 */
const PAYEE_ALIASES: { payee: string; acct: string; toPayee: string; toChannel: string }[] = [
  { payee: "龚建成", acct: "恒生", toPayee: "张文俊", toChannel: "香港" },
];

/**
 * 表格行 → 候选收款方式列表：账号列是卡号数字则按卡号匹配（同一卡号可能挂多个渠道，
 * 如 张文俊 的 工商 与 WISE 在库内共用同一卡号——表格只写卡号分不出渠道，
 * 全部作为候选交给金额比对定夺，谁的打款批次对得上就是谁）；
 * 是渠道文字（恒生/汇丰/PingPong…）则按 收款人+渠道 匹配。空数组 = 对不上（预览人工处理）。
 */
export function resolveMethodCandidates(row: { payee: string; acct: string }, methods: ImportMethod[]): ImportMethod[] {
  const rowAcctText = normText(row.acct);
  for (const a of PAYEE_ALIASES) {
    if (row.payee === a.payee && rowAcctText.includes(a.acct)) {
      const hit = methods.filter((m) => m.payeeName === a.toPayee && normText(m.payChannel).includes(a.toChannel));
      if (hit.length > 0) return hit;
    }
  }
  const digits = normDigits(row.acct);
  if (digits.length >= 6) {
    const byPayee = methods.filter((m) => normDigits(m.cardNo) === digits && m.payeeName === row.payee);
    if (byPayee.length > 0) return byPayee;
    return methods.filter((m) => normDigits(m.cardNo) === digits);
  }
  const acctText = normText(row.acct);
  if (!acctText) return [];
  return methods.filter(
    (m) => m.payeeName === row.payee && normText(m.payChannel) !== "" &&
      (normText(m.payChannel).includes(acctText) || acctText.includes(normText(m.payChannel))),
  );
}

// ── 匹配引擎 ─────────────────────────────────────────────────────────────────

/** 候选打款单（已完成卡归属与折 CNY，粒度 = platform×payment_no） */
export interface ImportPayment {
  paymentKey: string; // platform\0payment_no
  platform: string;
  /** 批次日（paid_date 优先） YYYY-MM-DD */
  date: string;
  methodId: string;
  userId: string;
  username: string;
  displayName: string;
  account: string;
  usd: number;
  cny: number;
}

export interface MatchedBreakdownItem {
  userId: string;
  username: string;
  displayName: string;
  platform: string;
  account: string;
  amount: number;
  sourceDate: string;
}

/** 既有条目的明细行（库内 breakdown，老条目可能没有 sourceDate） */
export interface ExistingBreakdownItem {
  userId: string;
  username: string;
  displayName: string;
  platform: string;
  account: string;
  amount: number;
  sourceDate?: string | null;
}

/** D-290：既有条目按银行到账拆出的一条子条目 */
export interface ImportSplitPart {
  txnDate: string;
  amount: number;
  platform: string;
  sourceDate: string | null;
  breakdown: ExistingBreakdownItem[];
  /** 该笔归属的人（预览展示用） */
  members: string[];
}

export interface ImportProposal {
  status: "auto" | "review" | "exists" | "unmatched" | "usd" | "no_method" | "date_fix" | "split_existing";
  /** 组成本条目的到账行（L4 拆分时多行） */
  rows: ParsedBankRow[];
  methodId: string | null;
  /** 实际到账合计（CNY 行）或美金合计（usd 状态） */
  amount: number;
  currency: "CNY" | "USD";
  /** 主平台（明细合计最大的平台；保存时 C-180 仍按明细逐行拆） */
  platform: string | null;
  txnDate: string | null;
  sourceDate: string | null;
  breakdown: MatchedBreakdownItem[];
  expected: number;
  fee: number;
  feeRate: number | null;
  /** 命中层级说明（预览展示） */
  matchNote: string;
  warnings: string[];
  /** D-290 date_fix / split_existing：要改动的既有条目 id（C-180 同组给组内全部 id） */
  entryIds?: string[];
  /** D-290 split_existing：按银行到账拆出的子条目（合计 = 原条目金额） */
  parts?: ImportSplitPart[];
}

interface Candidate {
  rowKeys: string[];
  paymentKeys: string[];
  fee: number; // 费率
  /** 排序键：负费率轻微惩罚，倾向正常的正手续费解 */
  sortFee: number;
  dateDist: number;
  batchCount: number;
  kind: "single" | "split";
  /** 0=卡号直配；1=同收款人跨渠道回退（如平台打到 PingPong 再提到银行卡），命中必标 review */
  tier: 0 | 1;
  /** 补捞命中（表格日期超常规窗口，07 2026-08-26 拍板：入账日按库内打款日，必标 review） */
  rescued?: boolean;
}

/** 带容差子集和：在 items 中找合计落进 [target, target×(1+FEE_MAX)]（含轻微负差）的子集，返回费率最小解 */
function bestSubset(
  items: { key: string; amt: number }[],
  target: number,
): { keys: string[]; sum: number; fee: number } | null {
  const sorted = [...items].sort((a, b) => b.amt - a.amt);
  const n = sorted.length;
  const suffix = new Array<number>(n + 1).fill(0);
  for (let i = n - 1; i >= 0; i--) suffix[i] = suffix[i + 1] + sorted[i].amt;
  const lo = target * (1 + FEE_MIN);
  const hi = target / (1 - FEE_MAX);
  let best: { keys: string[]; sum: number; fee: number } | null = null;
  let budget = DFS_BUDGET;
  const picked: number[] = [];
  const dfs = (i: number, sum: number) => {
    if (budget-- <= 0) return;
    if (sum >= lo && sum <= hi && picked.length > 0) {
      const fee = (sum - target) / sum;
      if (fee >= FEE_MIN && fee <= FEE_MAX && (!best || Math.abs(fee) < Math.abs(best.fee))) {
        best = { keys: picked.map((p) => sorted[p].key), sum: r2(sum), fee };
      }
    }
    if (i >= n || sum > hi || sum + suffix[i] < lo) return;
    if (best && Math.abs(best.fee) < 0.0001) return; // 已找到近乎精确解
    picked.push(i);
    dfs(i + 1, sum + sorted[i].amt);
    picked.pop();
    dfs(i + 1, sum);
  };
  dfs(0, 0);
  return best;
}

/**
 * 到账行组合搜索（L4）：在同卡的到账行里找 2~8 笔合计 ≈ target（批次该卡份额）。
 * 与 bestSubset 方向相反：这里手续费 = (批次额 − 到账合计) / 批次额。
 */
function bestRowGroup(
  rows: { key: string; amt: number; date: string }[],
  target: number,
): { keys: string[]; sum: number; fee: number } | null {
  const sorted = [...rows].sort((a, b) => b.amt - a.amt);
  const n = sorted.length;
  const suffix = new Array<number>(n + 1).fill(0);
  for (let i = n - 1; i >= 0; i--) suffix[i] = suffix[i + 1] + sorted[i].amt;
  const lo = target * (1 - FEE_MAX);
  const hi = target * (1 - FEE_MIN);
  let best: { keys: string[]; sum: number; fee: number } | null = null;
  let budget = DFS_BUDGET;
  const picked: number[] = [];
  const dfs = (i: number, sum: number) => {
    if (budget-- <= 0) return;
    if (picked.length >= 2 && sum >= lo && sum <= hi) {
      const fee = (target - sum) / target;
      if (!best || Math.abs(fee) < Math.abs(best.fee)) {
        best = { keys: picked.map((p) => sorted[p].key), sum: r2(sum), fee };
      }
    }
    if (i >= n || picked.length >= 8 || sum > hi || sum + suffix[i] < lo) return;
    picked.push(i);
    dfs(i + 1, sum + sorted[i].amt);
    picked.pop();
    dfs(i + 1, sum);
  };
  dfs(0, 0);
  return best;
}

const sortFeeOf = (fee: number) => (fee < 0 ? Math.abs(fee) + 0.002 : fee);

export interface MatchInput {
  rows: ParsedBankRow[];
  methods: ImportMethod[];
  payments: ImportPayment[];
  /**
   * 已登记批次：`${methodId}\0${platform}\0${date}` 集合（条目 source_date + 明细行 sourceDate），
   * 命中的打款单不再参与匹配（与 prefill/candidates 防重复口径一致）
   */
  usedBatchKeys: Set<string>;
  /** 既有条目（本口径全部未删），用于「已录过」判定与 D-290 的校正日期/按银行拆分提案 */
  existingEntries: ExistingEntry[];
}

/** 既有条目（C-180 同 txn_group 的多条按组合并成一项，ids 给组内全部 id） */
export interface ExistingEntry {
  ids: string[];
  methodId: string;
  /** 收款方式渠道：WISE = 平台一笔打款、我们分批回款（07 2026-08-27：不拆） */
  payChannel: string;
  amount: number;
  txnDate: string;
  expected: number;
  fee: number;
  breakdown: ExistingBreakdownItem[];
  /** C-180 组条目已按平台拆过，不再按银行拆 */
  splittable: boolean;
}

const isTrancheChannel = (ch: string) => /WISE/i.test(ch || "");

/**
 * D-290：把既有条目的明细按「净额」精确分配到银行的各笔到账上。
 * 净额 = 明细金额 × (1 − 条目费率)，实证 6/16 PM（413.03 = 蓝晨馨）与 8/12 PM 都能整除到人。
 * 有一笔落不到人就整体返回 null —— 宁可跳过请人工处理，也不按比例硬摊（数据真实性规范）。
 */
function assignPartsByMember(e: ExistingEntry, rs: ParsedBankRow[]): ImportSplitPart[] | null {
  if (e.breakdown.length === 0) return null;
  const feeRate = e.expected > 0 ? e.fee / e.expected : 0;
  const nets = e.breakdown.map((it) => r2((it.amount || 0) * (1 - feeRate)));
  const remaining = new Set(e.breakdown.map((_, i) => i));
  const picks = new Map<string, number[]>();
  // 金额大的先认领：小额行更容易被子集凑出来，先认大额可减少歧义
  for (const r of [...rs].sort((a, b) => (b.cny ?? 0) - (a.cny ?? 0))) {
    if (r.cny == null) return null;
    const pool = [...remaining].map((i) => ({ key: String(i), amt: nets[i] }));
    // 每行净额各带 ≤0.005 的四舍五入误差，容差随参与行数放宽
    const hit = exactSubset(pool, r.cny, Math.max(0.05, 0.011 * pool.length));
    if (!hit) return null;
    for (const k of hit) remaining.delete(Number(k));
    picks.set(r.key, hit.map(Number));
  }
  if (remaining.size > 0) return null; // 有人没被任何一笔认领 → 落不到人
  return rs.map((r) => {
    const items = picks.get(r.key)!.map((i) => e.breakdown[i]);
    const platSum = new Map<string, number>();
    for (const it of items) platSum.set(it.platform, (platSum.get(it.platform) ?? 0) + (it.amount || 0));
    const dates = [...new Set(items.map((it) => it.sourceDate || "").filter(Boolean))].sort();
    return {
      txnDate: r.date,
      amount: r2(r.cny!),
      platform: [...platSum.entries()].sort((a, b) => b[1] - a[1])[0][0],
      sourceDate: dates[0] ?? null,
      breakdown: items,
      members: items.map((it) => it.displayName || it.username),
    };
  });
}

/** 精确子集和（目标 ±tol），用于把明细净额落到银行的某一笔到账上 */
function exactSubset(items: { key: string; amt: number }[], target: number, tol: number): string[] | null {
  const sorted = [...items].sort((a, b) => b.amt - a.amt);
  const n = sorted.length;
  const suffix = new Array<number>(n + 1).fill(0);
  for (let i = n - 1; i >= 0; i--) suffix[i] = suffix[i + 1] + sorted[i].amt;
  let hit: string[] | null = null;
  let budget = DFS_BUDGET;
  const picked: number[] = [];
  const dfs = (i: number, sum: number) => {
    if (hit || budget-- <= 0) return;
    if (picked.length > 0 && Math.abs(sum - target) <= tol) { hit = picked.map((p) => sorted[p].key); return; }
    if (i >= n || sum > target + tol || sum + suffix[i] < target - tol) return;
    picked.push(i);
    dfs(i + 1, sum + sorted[i].amt);
    picked.pop();
    dfs(i + 1, sum);
  };
  dfs(0, 0);
  return hit;
}

export function matchBankRows(input: MatchInput): ImportProposal[] {
  const { rows, methods, payments, usedBatchKeys, existingEntries } = input;
  const methodById = new Map(methods.map((m) => [m.id, m]));
  const proposals: ImportProposal[] = [];
  const assigned = new Set<string>(); // row key

  // ── 0. 卡归属（候选列表，金额比对定夺归属；同卡号多渠道时谁的批次对得上就是谁） ──
  const methodsOf = new Map<string, ImportMethod[]>();
  for (const r of rows) methodsOf.set(r.key, resolveMethodCandidates(r, methods));

  // ── 1. 已录过判定：单行金额 ≈ 既有条目；或同卡多行合计 ≈ 既有条目（银行分多笔到账） ──
  const usedEntries = new Set<number>();
  /**
   * D-290：既有条目与银行行对上之后的三种结论 ——
   * 单行日期差 ≤5 天 → 校正到账日；多行合计对上且非 WISE → 按银行拆分；其余照旧跳过。
   */
  const resolveExisting = (rs: ParsedBankRow[], entryIdx: number, e: ExistingEntry) => {
    usedEntries.add(entryIdx);
    for (const r of rs) assigned.add(r.key);
    const base = {
      rows: rs,
      methodId: e.methodId,
      amount: r2(rs.reduce((s, r) => s + (r.cny ?? r.usd ?? 0), 0)),
      currency: (rs[0].cny != null ? "CNY" : "USD") as "CNY" | "USD",
      platform: null as string | null,
      sourceDate: null,
      breakdown: [], expected: 0, fee: 0, feeRate: null,
      warnings: [] as string[],
    };
    const batchDate = [...new Set(e.breakdown.map((it) => it.sourceDate || "").filter(Boolean))].sort()[0];

    if (rs.length === 1) {
      const gap = Math.round(signedDays(e.txnDate, rs[0].date)); // 正 = 库内登记日晚于银行
      if (gap === 0) {
        proposals.push({ ...base, status: "exists", txnDate: e.txnDate, matchNote: "与已登记流水金额一致，跳过" });
        return;
      }
      // 银行日期早于打款日 = 物理不可能，按表格日期改反而错（留 2 天时区/记账余量）
      const impossible = !!batchDate && signedDays(batchDate, rs[0].date) > 2;
      if (Math.abs(gap) <= DATE_FIX_MAX_DAYS && !impossible) {
        proposals.push({
          ...base, status: "date_fix", entryIds: e.ids, txnDate: rs[0].date,
          matchNote: `金额与已登记流水一致，登记日 ${e.txnDate} 与银行 ${rs[0].date} 差 ${Math.abs(gap)} 天（≤${DATE_FIX_MAX_DAYS} 天以银行为准），校正到账日`,
        });
        return;
      }
      proposals.push({
        ...base, status: "exists", txnDate: e.txnDate,
        matchNote: impossible
          ? `与已登记流水金额一致（表格日期 ${rs[0].date} 早于打款日 ${batchDate}，表格有误），保留登记日 ${e.txnDate}，跳过`
          : `与已登记流水金额一致（登记日 ${e.txnDate} 与表格差 ${Math.abs(gap)} 天，超 ${DATE_FIX_MAX_DAYS} 天以实际到账时间为准），保留现值，跳过`,
      });
      return;
    }

    // 多行合计 = 一个既有条目
    const rowsText = rs.map((r) => `${r.date} ¥${(r.cny ?? 0).toFixed(2)}`).join("、");
    if (isTrancheChannel(e.payChannel)) {
      proposals.push({
        ...base, status: "exists", txnDate: e.txnDate,
        matchNote: `银行分 ${rs.length} 笔到账（${rowsText}），合计与已登记流水一致；${e.payChannel} 是平台一笔打款、分批回款，保持一条，跳过`,
      });
      return;
    }
    if (!e.splittable) {
      proposals.push({
        ...base, status: "exists", txnDate: e.txnDate,
        matchNote: `银行分 ${rs.length} 笔到账（${rowsText}），合计与已登记流水一致；该条目已按平台拆分（C-180），需人工处理，跳过`,
      });
      return;
    }
    const parts = assignPartsByMember(e, rs);
    if (!parts) {
      proposals.push({
        ...base, status: "exists", txnDate: e.txnDate,
        matchNote: `银行分 ${rs.length} 笔到账（${rowsText}），合计一致但明细金额落不到具体的人，未自动拆分，请手工处理`,
        warnings: ["按明细净额凑不出银行的分笔金额，没有按比例硬摊"],
      });
      return;
    }
    proposals.push({
      ...base, status: "split_existing", entryIds: e.ids, parts,
      txnDate: parts[0].txnDate, platform: parts[0].platform,
      matchNote: `银行分 ${rs.length} 笔到账，按明细净额拆开：${parts.map((p) => `${p.txnDate} ¥${p.amount.toFixed(2)}（${p.members.join("+")}）`).join("；")}`,
    });
  };
  // 已录过判定按「同收款人」放宽：历史条目可能登记在同人的另一渠道（如到账进银行卡、
  // 但当时录在 PingPong 收款方式下），金额精确一致即认为是同一笔
  const entryMatchesRow = (r: ParsedBankRow, entryMethodId: string): boolean => {
    if (methodsOf.get(r.key)?.some((m) => m.id === entryMethodId)) return true;
    const em = methodById.get(entryMethodId);
    return !!em && em.payeeName === r.payee;
  };
  // 两轮窗口：先近距（10 天）优先配对，再宽窗（表格日期可能写错，实证差 12~20 天），金额都要求 ±0.05 精确一致
  for (const existsWindow of [10, RESCUE_WINDOW_DAYS]) {
    existingEntries.forEach((e, idx) => {
      if (usedEntries.has(idx)) return;
      for (const r of rows) {
        if (assigned.has(r.key) || r.cny == null) continue;
        if (!entryMatchesRow(r, e.methodId)) continue;
        if (Math.abs(r.cny - e.amount) <= 0.05 && daysBetween(r.date, e.txnDate) <= existsWindow) {
          resolveExisting([r], idx, e);
          return;
        }
      }
    });
  }
  // 多行合计 = 既有条目（历史上 WISE 拆 5 笔录成一条）
  existingEntries.forEach((e, idx) => {
    if (usedEntries.has(idx)) return;
    const byMethod = rows.filter((r) =>
      !assigned.has(r.key) && r.cny != null &&
      entryMatchesRow(r, e.methodId) &&
      daysBetween(r.date, e.txnDate) <= SPLIT_WINDOW_DAYS,
    );
    if (byMethod.length < 2) return;
    // 精确合计（±0.05）才认已录过，避免误吞
    const sorted = [...byMethod].sort((a, b) => (b.cny ?? 0) - (a.cny ?? 0));
    const suffix = new Array<number>(sorted.length + 1).fill(0);
    for (let i = sorted.length - 1; i >= 0; i--) suffix[i] = suffix[i + 1] + (sorted[i].cny ?? 0);
    let hit: ParsedBankRow[] | null = null;
    const picked: number[] = [];
    let budget = 100000;
    const dfs = (i: number, sum: number) => {
      if (hit || budget-- <= 0) return;
      if (picked.length >= 2 && Math.abs(sum - e.amount) <= 0.05) { hit = picked.map((p) => sorted[p]); return; }
      if (i >= sorted.length || sum > e.amount + 0.05 || sum + suffix[i] < e.amount - 0.05) return;
      picked.push(i);
      dfs(i + 1, sum + (sorted[i].cny ?? 0));
      picked.pop();
      dfs(i + 1, sum);
    };
    dfs(0, 0);
    if (hit) resolveExisting((hit as ParsedBankRow[]).sort((a, b) => a.date.localeCompare(b.date)), idx, e);
  });

  // ── 2. 候选打款池（剔除已登记批次） ──
  const pool = payments.filter((p) => !usedBatchKeys.has(`${p.methodId}\u0000${p.platform}\u0000${p.date}`));
  const poolByMethod = new Map<string, ImportPayment[]>();
  for (const p of pool) {
    const arr = poolByMethod.get(p.methodId) ?? [];
    arr.push(p);
    poolByMethod.set(p.methodId, arr);
  }
  const paymentByKey = new Map(pool.map((p) => [`${p.methodId}\u0000${p.paymentKey}`, p]));

  // ── 3+4. 两阶段候选与全局分配 ──
  // 阶段一：单笔到账匹配（一行 = 打款池子集）——先分配，防止拆分组合"偷行"凑数
  //（实测教训：6 月 WISE 拆分组合把本属于农业卡单笔匹配的行吸进去凑出 0.01% 假精确解）。
  // 阶段二：一批拆多笔（L4），目标额 = 该卡该批次**未被阶段一消费**的余额。
  // 每阶段内按 tier（卡号直配优先于同收款人跨渠道回退）→ 费率 → 批次数 → 日期距离排序认领；
  // 每笔打款单只能被消费一次、每笔到账只归一个条目。
  const rowByKey = new Map(rows.map((r) => [r.key, r]));
  const consumedPayments = new Set<string>();
  const applied: Candidate[] = [];
  const sortAndApply = (candidates: Candidate[]) => {
    candidates.sort((a, b) => a.tier - b.tier || a.sortFee - b.sortFee || a.batchCount - b.batchCount || a.dateDist - b.dateDist);
    for (const c of candidates) {
      if (c.rowKeys.some((k) => assigned.has(k))) continue;
      if (c.paymentKeys.some((k) => consumedPayments.has(k))) continue;
      for (const k of c.rowKeys) assigned.add(k);
      for (const k of c.paymentKeys) consumedPayments.add(k);
      applied.push(c);
    }
  };

  /** 行的候选卡：tier0 = 卡号/渠道直配；tier1 = 同收款人其他卡（平台打款渠道与银行落地卡不一致的场景） */
  const candidateMethodsOf = (r: ParsedBankRow): { m: ImportMethod; tier: 0 | 1 }[] => {
    const primary = methodsOf.get(r.key) ?? [];
    const primaryIds = new Set(primary.map((m) => m.id));
    const fallback = methods.filter((m) => m.payeeName === r.payee && !primaryIds.has(m.id));
    return [
      ...primary.map((m) => ({ m, tier: 0 as const })),
      ...fallback.map((m) => ({ m, tier: 1 as const })),
    ];
  };

  // ── 阶段一：单笔匹配（循环补捞：某行的最优子集被别的行抢走后，用剩余池重算次优解） ──
  const runSingles = (windowDays: number, rescued: boolean, rounds: number) => {
    for (let round = 0; round < rounds; round++) {
      const singles: Candidate[] = [];
      for (const r of rows) {
        if (assigned.has(r.key)) continue;
        for (const { m, tier } of candidateMethodsOf(r)) {
          const mp = (poolByMethod.get(m.id) ?? []).filter(
            (p) => daysBetween(p.date, r.date) <= windowDays && !consumedPayments.has(`${m.id}\u0000${p.paymentKey}`),
          );
          if (mp.length === 0) continue;
          const isUsd = r.cny == null;
          const target = isUsd ? r.usd! : r.cny!;
          const items = mp
            .filter((p) => (isUsd ? p.usd : p.cny) > 0.005)
            .map((p) => ({ key: `${m.id}\u0000${p.paymentKey}`, amt: isUsd ? p.usd : p.cny }));
          if (items.length === 0) continue;
          const best = bestSubset(items, target);
          if (best) {
            const paymentsHit = best.keys.map((k) => paymentByKey.get(k)!);
            const batchSet = new Set(paymentsHit.map((p) => `${p.platform}|${p.date}`));
            const dateDist = Math.min(...paymentsHit.map((p) => daysBetween(p.date, r.date)));
            singles.push({
              rowKeys: [r.key],
              paymentKeys: best.keys,
              fee: best.fee,
              sortFee: sortFeeOf(best.fee),
              dateDist,
              batchCount: batchSet.size,
              kind: "single",
              tier,
              rescued,
            });
          }
        }
      }
      const before = applied.length;
      sortAndApply(singles);
      if (applied.length === before) break;
    }
  };
  runSingles(IMPORT_WINDOW_DAYS, false, 8);

  // ── 阶段二：一批拆多笔（L4，按 CNY；目标额 = 批次未消费余额；同样循环补捞） ──
  for (let round = 0; round < 4; round++) {
    const batchTotals = new Map<string, { methodId: string; platform: string; date: string; keys: string[]; cny: number }>();
    for (const p of pool) {
      const pk = `${p.methodId}\u0000${p.paymentKey}`;
      if (consumedPayments.has(pk)) continue;
      const bk = `${p.methodId}\u0000${p.platform}\u0000${p.date}`;
      const b = batchTotals.get(bk) ?? { methodId: p.methodId, platform: p.platform, date: p.date, keys: [], cny: 0 };
      b.keys.push(pk);
      b.cny = r2(b.cny + p.cny);
      batchTotals.set(bk, b);
    }
    const splits: Candidate[] = [];
    for (const b of batchTotals.values()) {
      if (b.cny < 0.01) continue;
      for (const tier of [0, 1] as const) {
        const groupRows = rows
          .filter((r) => {
            if (assigned.has(r.key) || r.cny == null || daysBetween(r.date, b.date) > SPLIT_WINDOW_DAYS) return false;
            const cands = candidateMethodsOf(r).filter((c) => c.tier === tier);
            return cands.some((c) => c.m.id === b.methodId);
          })
          .map((r) => ({ key: r.key, amt: r.cny!, date: r.date }));
        if (groupRows.length < 2) continue;
        const best = bestRowGroup(groupRows, b.cny);
        if (best && best.keys.length >= 2) {
          const dateDist = Math.min(...best.keys.map((k) => daysBetween(rowByKey.get(k)!.date, b.date)));
          splits.push({
            rowKeys: best.keys,
            paymentKeys: b.keys,
            fee: best.fee,
            sortFee: sortFeeOf(best.fee),
            dateDist,
            batchCount: 1,
            kind: "split",
            tier,
          });
        }
      }
    }
    const before = applied.length;
    sortAndApply(splits);
    if (applied.length === before) break;
  }

  // ── 阶段三：宽窗补捞（表格日期写错的行；入账日按库内打款日，必标 review） ──
  runSingles(RESCUE_WINDOW_DAYS, true, 2);

  // ── 5. 生成提案 ──
  for (const c of applied) {
    const rs = c.rowKeys.map((k) => rowByKey.get(k)!).sort((a, b) => a.date.localeCompare(b.date));
    const ps = c.paymentKeys.map((k) => paymentByKey.get(k)!);
    const m = methodById.get(ps[0].methodId)!;
    const isUsd = rs[0].cny == null;
    const amount = r2(rs.reduce((s, r) => s + (isUsd ? r.usd! : r.cny!), 0));

    // 明细行：组员×平台×账号×批次日 合并（与手动添加口径一致）
    const bdMap = new Map<string, MatchedBreakdownItem>();
    for (const p of ps) {
      const k = `${p.userId}|${p.platform}|${p.account}|${p.date}`;
      const cur = bdMap.get(k) ?? {
        userId: p.userId, username: p.username, displayName: p.displayName,
        platform: p.platform, account: p.account, amount: 0, sourceDate: p.date,
      };
      cur.amount = r2(cur.amount + (isUsd ? p.usd : p.cny));
      bdMap.set(k, cur);
    }
    const breakdown = [...bdMap.values()].sort((a, b) => a.platform.localeCompare(b.platform) || a.username.localeCompare(b.username));
    const expected = r2(breakdown.reduce((s, b) => s + b.amount, 0));
    const fee = r2(expected - amount);
    const feeRate = expected > 0 ? fee / expected : null;

    // 主平台 = 明细金额最大的平台；批次日 = 最早
    const platSum = new Map<string, number>();
    for (const b of breakdown) platSum.set(b.platform, (platSum.get(b.platform) ?? 0) + b.amount);
    const platform = [...platSum.entries()].sort((a, b) => b[1] - a[1])[0][0];
    const sourceDate = [...new Set(ps.map((p) => p.date))].sort()[0];
    const batches = [...new Set(ps.map((p) => `${p.platform} ${p.date}`))].sort();

    const warnings: string[] = [];
    if (feeRate != null && feeRate > REVIEW_FEE) warnings.push(`费率 ${(feeRate * 100).toFixed(2)}% 偏高，请复核`);
    if (feeRate != null && feeRate < 0) warnings.push("到账多于明细合计（汇差），入库时按 D-274.1 摊入明细");
    if (c.tier === 1) {
      warnings.push(`表格卡号对应的卡在打款记录里对不上，按金额比对归属到同收款人的「${m.payChannel || "另一张卡"}」，请复核`);
    }
    // 表格日期早于库内打款日：小幅早于是常态（平台记的 paid_date 会晚于实际到账，实测 LH 6-22 批 6-18 就到账），
    // 07 2026-08-27 拍板「相差 ≤5 天以银行流水为准」，故只有超过这个阈值才判表格有误、
    // 改按库内打款日入账（07 2026-08-26「表格确实有误，按照库内收款日导」，实证 2/12 vs 3/4 差 20 天）。
    const sheetDateTooEarly = !isUsd && signedDays(sourceDate, rs[0].date) > DATE_FIX_MAX_DAYS;
    const useDbDate = c.rescued || sheetDateTooEarly;
    if (c.rescued) {
      warnings.push(`表格日期 ${rs[0].date} 与库内打款日 ${sourceDate} 相差 ${Math.round(c.dateDist)} 天，判定表格日期有误，已按库内打款日入账，请复核`);
    } else if (sheetDateTooEarly) {
      warnings.push(`表格日期 ${rs[0].date} 早于库内打款日 ${sourceDate} 超过 ${DATE_FIX_MAX_DAYS} 天，判定表格日期有误，已按库内打款日入账，请复核`);
    } else if (c.dateDist > 7) {
      warnings.push(`打款日与到账日相差 ${Math.round(c.dateDist)} 天，请复核`);
    }
    if (c.kind === "split" && rs.length >= 2) {
      const span = daysBetween(rs[0].date, rs[rs.length - 1].date);
      if (span > 5) warnings.push(`拆分组合跨 ${Math.round(span)} 天（${rs.length} 笔到账），请逐笔核对`);
    }
    // 平台标注辅助校验：标注里出现的平台码与匹配结果不符时提醒
    const noteText = rs.map((r) => r.note).join(" ").toUpperCase();
    const notedPlats = [...new Set((noteText.match(/\b(CG|BSH|RW|LH|LB|PM|MUI|EV|CF|DF)\b/g) ?? []))];
    const matchedPlats = new Set(breakdown.map((b) => b.platform));
    const conflict = notedPlats.filter((p) => !matchedPlats.has(p));
    if (notedPlats.length > 0 && conflict.length > 0) {
      warnings.push(`表格标注平台 ${notedPlats.join("+")} 与匹配结果 ${[...matchedPlats].join("+")} 不一致，请复核`);
    }

    proposals.push({
      status: isUsd ? "usd" : warnings.length > 0 ? "review" : "auto",
      rows: rs,
      methodId: m.id,
      amount,
      currency: isUsd ? "USD" : "CNY",
      platform,
      // 表格日期判定有误（补捞命中/早于打款日）：入账日按库内打款日（07 2026-08-26 拍板）
      txnDate: useDbDate ? sourceDate : rs[0].date,
      sourceDate,
      breakdown,
      expected,
      fee,
      feeRate,
      matchNote: c.kind === "split"
        ? `一批拆 ${rs.length} 笔到账：${batches.join("、")}（${breakdown.length} 人）`
        : `匹配 ${batches.join("、")}（${ps.length} 笔打款 / ${breakdown.length} 人）`,
      warnings,
    });
  }

  // ── 6. 剩余：未命中 / 无卡 ──
  for (const r of rows) {
    if (assigned.has(r.key)) continue;
    const m = (methodsOf.get(r.key) ?? [])[0] ?? null;
    proposals.push({
      status: m ? "unmatched" : "no_method",
      rows: [r],
      methodId: m?.id ?? null,
      amount: r2(r.cny ?? r.usd ?? 0),
      currency: r.cny != null ? "CNY" : "USD",
      platform: null,
      txnDate: r.date,
      sourceDate: null,
      breakdown: [], expected: 0, fee: 0, feeRate: null,
      matchNote: m
        ? `±${IMPORT_WINDOW_DAYS} 天内没有费率 ≤${(FEE_MAX * 100).toFixed(1)}% 的打款组合，请用「登记平台打款」手工处理`
        : `收款人「${r.payee}」账号「${r.acct || "—"}」对不上任何收款方式，请先在小组设置维护`,
      warnings: [],
    });
  }

  // 展示顺序：到账日升序
  proposals.sort((a, b) => (a.txnDate || "").localeCompare(b.txnDate || "") || a.amount - b.amount);
  return proposals;
}
