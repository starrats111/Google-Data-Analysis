/**
 * R-02 月度收支报表 — 统一视图模型构建器
 *
 * 组员单月表 / 组长全员表 / 组长总计表 / xlsx 导出 全部走本模块，杜绝口径漂移。
 * 全部库内数据，绝不调联盟平台 API。
 *
 * 口径（2026-07-03 拍板）：
 * - 账面佣金 = 当月全部 status 交易佣金；失效 = rejected；按交易发生月归
 *   （复用 report-metrics 的平台后台时间口径）
 * - 应收/实收都按 affiliate_payments.request_date 归月归半月（1-15 上半月 / 16-月末 下半月），
 *   只计 status='paid'（processing 不计入，rejected 忽略）
 * - 应收 = 平台显示金额 amount；实收 = 毛额优先回退净额（paymentDisplayAmount），可手工纠正
 * - 广告费 = ads_daily_stats.cost(USD) 按 campaigns.mcc_id×月归集；
 *   覆盖值优先，无覆盖用 库内cost + mcc_cost_adjustments 补差额；
 *   CNY MCC 按当日汇率快照反算原币展示
 * - 汇率：当月实时（最新快照），历史月锁当月最后一日快照；报表头显示汇率日期
 * - 动态列按 平台+trim(账号名) 去重合并；同平台多账号用 平台1/平台2 后缀
 * - 收款方式：当月读实时绑定；历史月首次访问懒固化到 payment_binding_snapshots
 */

import prisma from "@/lib/prisma";
import { sqlTxnRange, REPORT_PLATFORM_ORDER, paymentDisplayAmount } from "@/lib/report-metrics";
import { nowCST, dateColumnStart } from "@/lib/date-utils";

// ─────────────────────────────────────────────────────────────
// 类型
// ─────────────────────────────────────────────────────────────

export interface MccSection {
  mccDbId: string;
  mccId: string;
  mccName: string;
  currency: string; // USD | CNY
  /** mcc_cost_adjustments 补差额（USD 口径，与数据中心一致） */
  adjustment: number;
  /** 库内 cost(USD) + 补差额 */
  costUsd: number;
  /** 原币金额（USD MCC = costUsd；CNY MCC = 按当日汇率反算 + 补差额折算） */
  costOriginal: number;
  /** 组员手动覆盖值（原币），null = 无覆盖 */
  override: number | null;
  /** 覆盖优先后的原币值 */
  effectiveOriginal: number;
  /** 覆盖优先后的 USD 值 */
  effectiveUsd: number;
}

export interface AccountColumn {
  platform: string;
  accountName: string; // trim 后
  label: string; // 展示名：单账号=平台代码，多账号=平台+序号
  connectionIds: string[];
  /** 账面佣金（USD，当月全部 status） */
  book: number;
  /** 失效佣金（USD，rejected） */
  rejected: number;
  /** 应收上/下半月（平台显示金额 amount） */
  recvH1: number;
  recvH2: number;
  /** 实收上/下半月（毛额优先回退净额，库内计算值） */
  paidH1: number;
  paidH2: number;
  /** 实收手工纠正（null = 无纠正） */
  paidH1Override: number | null;
  paidH2Override: number | null;
  /** 实收生效值（override ?? 计算值） */
  paidH1Effective: number;
  paidH2Effective: number;
  /** 收款方式（当月=实时绑定，历史月=快照） */
  payeeName: string;
  cardNo: string;
  /** 该账号当月是否有打款记录（无则实收/应收留空展示） */
  hasPayments: boolean;
}

export interface MemberMonthlyReport {
  month: string;
  userId: string;
  username: string;
  displayName: string;
  generatedAt: string;
  isCurrentMonth: boolean;
  /** CNY→USD 汇率快照（报表统一汇率） */
  rate: { cnyToUsd: number; usdToCny: number; date: string; locked: boolean };
  mccs: MccSection[];
  /** 广告费合计：USD MCC 的 USD 合计 / CNY MCC 的原币合计（分开，图2 格式） */
  adCostTotalUsd: number;
  adCostTotalCny: number;
  /** 用于核算利润的广告费（组员口径：CNY 按报表汇率折 USD + USD 累计） */
  profitAdCostUsd: number;
  /** 在投广告数（google_status=ENABLED 实时 COUNT） */
  enabledCampaigns: number;
  accounts: AccountColumn[];
  totals: {
    book: number;
    rejected: number;
    recvH1: number;
    recvH2: number;
    recvTotal: number;
    paidH1: number;
    paidH2: number;
    paidTotal: number;
  };
  /** 可分配利润 = 实收合计 − 核算广告费（USD），CNY 按报表汇率折算 */
  profit: { usd: number; cny: number };
  warnings: string[];
}

export interface TeamPlatformAgg {
  platform: string;
  book: number;
  rejected: number;
  recvH1: number;
  recvH2: number;
  recvTotal: number;
  paidH1: number;
  paidH2: number;
  paidTotal: number;
}

export interface TeamMonthlySummary {
  month: string;
  teamId: string;
  generatedAt: string;
  isCurrentMonth: boolean;
  rate: { cnyToUsd: number; usdToCny: number; date: string; locked: boolean };
  members: { userId: string; username: string; displayName: string }[];
  platforms: TeamPlatformAgg[];
  /** 全员广告费累计 */
  adCostTotalUsd: number;
  adCostTotalCny: number;
  /** 用于核算利润的广告费（组长口径：USD 按报表汇率折 CNY + CNY 累计） */
  profitAdCostCny: number;
  enabledCampaigns: number;
  totals: MemberMonthlyReport["totals"];
  /** 实收区 3 列 */
  paidUsdTotal: number; // 实收佣金(USD) = 员工累计
  estimatedPaidCny: number; // 预估实收(CNY) = 报表汇率折算
  actualPaidCny: number | null; // 实际佣金(CNY) = 组长手填
  /** 可分配利润(CNY) = (实际佣金 ?? 预估实收) − 核算广告费 */
  profitCny: number;
  warnings: string[];
}

// ─────────────────────────────────────────────────────────────
// 汇率
// ─────────────────────────────────────────────────────────────

/**
 * 报表统一汇率：当月 = 最新快照（实时刷新）；历史月 = 当月最后一日（或其前最近）快照锁定。
 */
export async function getReportRate(month: string): Promise<{
  cnyToUsd: number;
  usdToCny: number;
  date: string;
  locked: boolean;
}> {
  const currentMonth = nowCST().format("YYYY-MM");
  const isCurrent = month >= currentMonth;

  let snapshot: { date: Date; rate_to_usd: unknown } | null;
  if (isCurrent) {
    snapshot = await prisma.exchange_rate_snapshots.findFirst({
      where: { currency: "CNY" },
      orderBy: { date: "desc" },
    });
  } else {
    // 当月最后一日：下月 1 日的前一天
    const monthEnd = nextMonthStart(month);
    snapshot = await prisma.exchange_rate_snapshots.findFirst({
      where: { currency: "CNY", date: { lt: dateColumnStart(monthEnd) } },
      orderBy: { date: "desc" },
    });
  }

  if (!snapshot) {
    return { cnyToUsd: 0, usdToCny: 0, date: "", locked: !isCurrent };
  }
  const cnyToUsd = Number(snapshot.rate_to_usd);
  return {
    cnyToUsd,
    usdToCny: cnyToUsd > 0 ? 1 / cnyToUsd : 0,
    date: snapshot.date.toISOString().slice(0, 10),
    locked: !isCurrent,
  };
}

/** "YYYY-MM" → 下月 1 日 "YYYY-MM-DD" */
function nextMonthStart(month: string): string {
  const [y, m] = month.split("-").map(Number);
  const ny = m === 12 ? y + 1 : y;
  const nm = m === 12 ? 1 : m + 1;
  return `${ny}-${String(nm).padStart(2, "0")}-01`;
}

const r2 = (n: number) => Number(n.toFixed(2));

// ─────────────────────────────────────────────────────────────
// 组员单月表
// ─────────────────────────────────────────────────────────────

export async function buildMemberMonthlyReport(
  userId: bigint,
  month: string,
): Promise<MemberMonthlyReport> {
  const warnings: string[] = [];
  const monthStart = `${month}-01`;
  const monthEnd = nextMonthStart(month);
  const currentMonth = nowCST().format("YYYY-MM");
  const isCurrentMonth = month >= currentMonth;

  const [user, rate, overridesRaw] = await Promise.all([
    prisma.users.findFirst({
      where: { id: userId, is_deleted: 0 },
      select: { id: true, username: true, display_name: true },
    }),
    getReportRate(month),
    prisma.report_overrides.findMany({
      where: { user_id: userId, month, is_deleted: 0 },
    }),
  ]);
  if (!user) throw new Error(`用户 ${userId} 不存在`);
  if (rate.cnyToUsd <= 0) warnings.push("CNY 汇率快照缺失，人民币折算列不可用");
  const overrides = new Map(overridesRaw.map((o) => [o.scope_key, Number(o.value)]));

  // ── 1. 动态账号列（活跃连接按 平台+trim(账号名) 去重合并） ──────────
  const conns = await prisma.platform_connections.findMany({
    where: { user_id: userId, is_deleted: 0 },
    select: { id: true, platform: true, account_name: true, payment_method_id: true },
    orderBy: { created_at: "asc" },
  });

  type ColKey = string; // `${platform}\u0000${trimmedName}`
  const colByKey = new Map<ColKey, AccountColumn>();
  const colKeyByConnId = new Map<string, ColKey>();
  const methodIdByColKey = new Map<ColKey, bigint | null>();

  for (const c of conns) {
    const name = (c.account_name || "").trim();
    const key = `${c.platform}\u0000${name}`;
    if (!colByKey.has(key)) {
      colByKey.set(key, {
        platform: c.platform,
        accountName: name,
        label: "", // 后面统一编号
        connectionIds: [],
        book: 0, rejected: 0,
        recvH1: 0, recvH2: 0,
        paidH1: 0, paidH2: 0,
        paidH1Override: null, paidH2Override: null,
        paidH1Effective: 0, paidH2Effective: 0,
        payeeName: "", cardNo: "",
        hasPayments: false,
      });
      methodIdByColKey.set(key, c.payment_method_id);
    } else if (!methodIdByColKey.get(key) && c.payment_method_id) {
      // 重复连接中任一条有绑定即取用
      methodIdByColKey.set(key, c.payment_method_id);
    }
    colByKey.get(key)!.connectionIds.push(String(c.id));
    colKeyByConnId.set(String(c.id), key);
  }

  /** 把（可能已删除的）连接归到列：先按 conn id，再按 平台+名称 合并，最后回退平台唯一列 */
  const resolveColKey = (
    connId: string | null,
    platform: string,
    fallbackName?: string,
  ): ColKey | null => {
    if (connId && colKeyByConnId.has(connId)) return colKeyByConnId.get(connId)!;
    if (fallbackName !== undefined) {
      const key = `${platform}\u0000${fallbackName.trim()}`;
      if (colByKey.has(key)) return key;
    }
    const platformCols = [...colByKey.keys()].filter((k) => k.startsWith(`${platform}\u0000`));
    if (platformCols.length === 1) return platformCols[0];
    return null;
  };

  // ── 2. 账面/失效佣金（当月交易，平台后台时间口径） ──────────────────
  const txnRange = sqlTxnRange("t", monthStart, monthEnd);
  const txnRows = await prisma.$queryRawUnsafe<{
    platform: string;
    platform_connection_id: bigint | null;
    account_name: string | null;
    book: number;
    rejected: number;
  }[]>(`
    SELECT
      t.platform,
      t.platform_connection_id,
      pc.account_name,
      SUM(CAST(t.commission_amount AS DECIMAL(14,4))) AS book,
      SUM(CASE WHEN t.status = 'rejected' THEN CAST(t.commission_amount AS DECIMAL(14,4)) ELSE 0 END) AS rejected
    FROM affiliate_transactions t
    LEFT JOIN platform_connections pc ON pc.id = t.platform_connection_id
    WHERE t.user_id = ? AND t.is_deleted = 0 AND ${txnRange.cond}
    GROUP BY t.platform, t.platform_connection_id, pc.account_name
  `, userId, ...txnRange.params);

  const orphanTxns = new Map<string, { book: number; rejected: number }>();
  for (const row of txnRows) {
    const key = resolveColKey(
      row.platform_connection_id ? String(row.platform_connection_id) : null,
      row.platform,
      row.account_name ?? undefined,
    );
    if (key) {
      const col = colByKey.get(key)!;
      col.book += Number(row.book || 0);
      col.rejected += Number(row.rejected || 0);
    } else {
      const o = orphanTxns.get(row.platform) || { book: 0, rejected: 0 };
      o.book += Number(row.book || 0);
      o.rejected += Number(row.rejected || 0);
      orphanTxns.set(row.platform, o);
    }
  }
  for (const [platform, o] of orphanTxns) {
    warnings.push(`${platform} 有 $${r2(o.book)} 佣金无法归属到现有账号（历史连接已删除），已单列`);
    const key = `${platform}\u0000(历史账号)`;
    colByKey.set(key, {
      platform, accountName: "(历史账号)", label: "", connectionIds: [],
      book: o.book, rejected: o.rejected,
      recvH1: 0, recvH2: 0, paidH1: 0, paidH2: 0,
      paidH1Override: null, paidH2Override: null,
      paidH1Effective: 0, paidH2Effective: 0,
      payeeName: "", cardNo: "", hasPayments: false,
    });
  }

  // ── 3. 应收/实收（打款记录按 request_date 归半月，只计 paid） ──────
  const payments = await prisma.affiliate_payments.findMany({
    where: {
      user_id: userId,
      is_deleted: 0,
      status: "paid",
      request_date: { gte: new Date(`${monthStart}T00:00:00Z`), lt: new Date(`${monthEnd}T00:00:00Z`) },
    },
    select: {
      platform: true, platform_connection_id: true,
      request_date: true, amount: true, gross_amount: true,
    },
  });

  for (const p of payments) {
    const key = resolveColKey(
      p.platform_connection_id ? String(p.platform_connection_id) : null,
      p.platform,
    );
    if (!key) {
      warnings.push(`${p.platform} 有打款记录无法归属到现有账号，已忽略（$${r2(Number(p.amount))}）`);
      continue;
    }
    const col = colByKey.get(key)!;
    col.hasPayments = true;
    const day = p.request_date!.getUTCDate();
    const recv = Number(p.amount || 0);
    const paid = paymentDisplayAmount(Number(p.amount || 0), p.gross_amount == null ? null : Number(p.gross_amount));
    if (day <= 15) {
      col.recvH1 += recv;
      col.paidH1 += paid;
    } else {
      col.recvH2 += recv;
      col.paidH2 += paid;
    }
  }

  // ── 4. 列排序 + 编号 + 实收覆盖 ─────────────────────────────────────
  const accounts = [...colByKey.values()].sort((a, b) => {
    const ia = REPORT_PLATFORM_ORDER.indexOf(a.platform);
    const ib = REPORT_PLATFORM_ORDER.indexOf(b.platform);
    const oa = ia === -1 ? 99 : ia;
    const ob = ib === -1 ? 99 : ib;
    if (oa !== ob) return oa - ob;
    return a.accountName.localeCompare(b.accountName);
  });
  const platformCount = new Map<string, number>();
  for (const col of accounts) platformCount.set(col.platform, (platformCount.get(col.platform) || 0) + 1);
  const platformIdx = new Map<string, number>();
  for (const col of accounts) {
    const idx = (platformIdx.get(col.platform) || 0) + 1;
    platformIdx.set(col.platform, idx);
    col.label = (platformCount.get(col.platform) || 1) > 1 ? `${col.platform}${idx}` : col.platform;
    col.book = r2(col.book);
    col.rejected = r2(col.rejected);
    col.recvH1 = r2(col.recvH1);
    col.recvH2 = r2(col.recvH2);
    col.paidH1 = r2(col.paidH1);
    col.paidH2 = r2(col.paidH2);
    const ovH1 = overrides.get(`recv:${col.platform}:${col.accountName}:H1`);
    const ovH2 = overrides.get(`recv:${col.platform}:${col.accountName}:H2`);
    col.paidH1Override = ovH1 !== undefined ? r2(ovH1) : null;
    col.paidH2Override = ovH2 !== undefined ? r2(ovH2) : null;
    col.paidH1Effective = col.paidH1Override ?? col.paidH1;
    col.paidH2Effective = col.paidH2Override ?? col.paidH2;
    if (!col.hasPayments && (col.book > 0 || col.rejected > 0)) {
      warnings.push(`${col.label}/${col.accountName} 当月无打款记录，应收/实收留空`);
    }
  }

  // ── 5. 收款方式（当月实时绑定 / 历史月快照懒固化） ─────────────────
  await attachPaymentBindings(userId, month, isCurrentMonth, accounts, methodIdByColKey);

  // ── 6. 广告费（MCC×月，覆盖优先，CNY 反算原币） ────────────────────
  const mccs = await buildMccSections(userId, month, monthStart, monthEnd, rate, overrides, warnings);

  // ── 7. 在投广告数 ──────────────────────────────────────────────────
  const enabledCampaigns = await prisma.campaigns.count({
    where: { user_id: userId, is_deleted: 0, google_status: "ENABLED" },
  });

  // ── 8. 合计 & 利润 ────────────────────────────────────────────────
  const totals = {
    book: r2(accounts.reduce((s, c) => s + c.book, 0)),
    rejected: r2(accounts.reduce((s, c) => s + c.rejected, 0)),
    recvH1: r2(accounts.reduce((s, c) => s + c.recvH1, 0)),
    recvH2: r2(accounts.reduce((s, c) => s + c.recvH2, 0)),
    recvTotal: 0,
    paidH1: r2(accounts.reduce((s, c) => s + c.paidH1Effective, 0)),
    paidH2: r2(accounts.reduce((s, c) => s + c.paidH2Effective, 0)),
    paidTotal: 0,
  };
  totals.recvTotal = r2(totals.recvH1 + totals.recvH2);
  totals.paidTotal = r2(totals.paidH1 + totals.paidH2);

  const adCostTotalUsd = r2(mccs.filter((m) => m.currency !== "CNY").reduce((s, m) => s + m.effectiveUsd, 0));
  const adCostTotalCny = r2(mccs.filter((m) => m.currency === "CNY").reduce((s, m) => s + m.effectiveOriginal, 0));
  const profitAdCostUsd = r2(mccs.reduce((s, m) => s + m.effectiveUsd, 0));

  const profitUsd = r2(totals.paidTotal - profitAdCostUsd);
  const profitCny = rate.usdToCny > 0 ? r2(profitUsd * rate.usdToCny) : 0;

  return {
    month,
    userId: String(user.id),
    username: user.username,
    displayName: user.display_name || user.username,
    generatedAt: nowCST().format("YYYY-MM-DD HH:mm:ss"),
    isCurrentMonth,
    rate,
    mccs,
    adCostTotalUsd,
    adCostTotalCny,
    profitAdCostUsd,
    enabledCampaigns,
    accounts,
    totals,
    profit: { usd: profitUsd, cny: profitCny },
    warnings,
  };
}

// ─────────────────────────────────────────────────────────────
// 收款方式绑定（当月实时 / 历史月快照懒固化）
// ─────────────────────────────────────────────────────────────

async function attachPaymentBindings(
  userId: bigint,
  month: string,
  isCurrentMonth: boolean,
  accounts: AccountColumn[],
  methodIdByColKey: Map<string, bigint | null>,
): Promise<void> {
  const readCurrentBindings = async () => {
    const methodIds = [...new Set([...methodIdByColKey.values()].filter((v): v is bigint => v != null))];
    if (methodIds.length === 0) return new Map<string, { payee_name: string; card_no: string }>();
    const methods = await prisma.payment_methods.findMany({
      where: { id: { in: methodIds } }, // 不过滤 is_deleted：已删清单项仍按原文本显示
      select: { id: true, payee_name: true, card_no: true },
    });
    const byId = new Map(methods.map((m) => [String(m.id), { payee_name: m.payee_name, card_no: m.card_no }]));
    const byColKey = new Map<string, { payee_name: string; card_no: string }>();
    for (const [colKey, mid] of methodIdByColKey) {
      if (mid != null && byId.has(String(mid))) byColKey.set(colKey, byId.get(String(mid))!);
    }
    return byColKey;
  };

  if (isCurrentMonth) {
    const bindings = await readCurrentBindings();
    for (const col of accounts) {
      const b = bindings.get(`${col.platform}\u0000${col.accountName}`);
      if (b) { col.payeeName = b.payee_name; col.cardNo = b.card_no; }
    }
    return;
  }

  // 历史月：读快照；无快照则用当前绑定懒固化
  let snapshots = await prisma.payment_binding_snapshots.findMany({
    where: { user_id: userId, month },
  });
  if (snapshots.length === 0) {
    const bindings = await readCurrentBindings();
    const toCreate = accounts
      .filter((c) => c.accountName !== "(历史账号)")
      .map((c) => {
        const b = bindings.get(`${c.platform}\u0000${c.accountName}`);
        return {
          user_id: userId,
          month,
          platform: c.platform,
          account_name: c.accountName,
          payee_name: b?.payee_name || "",
          card_no: b?.card_no || "",
        };
      });
    if (toCreate.length > 0) {
      await prisma.payment_binding_snapshots.createMany({ data: toCreate, skipDuplicates: true });
      snapshots = await prisma.payment_binding_snapshots.findMany({ where: { user_id: userId, month } });
    }
  }
  const snapMap = new Map(snapshots.map((s) => [`${s.platform}\u0000${s.account_name}`, s]));
  for (const col of accounts) {
    const s = snapMap.get(`${col.platform}\u0000${col.accountName}`);
    if (s) { col.payeeName = s.payee_name; col.cardNo = s.card_no; }
  }
}

// ─────────────────────────────────────────────────────────────
// 广告费 MCC 段
// ─────────────────────────────────────────────────────────────

async function buildMccSections(
  userId: bigint,
  month: string,
  monthStart: string,
  monthEnd: string,
  rate: { cnyToUsd: number; usdToCny: number },
  overrides: Map<string, number>,
  warnings: string[],
): Promise<MccSection[]> {
  const mccAccounts = await prisma.google_mcc_accounts.findMany({
    where: { user_id: userId, is_deleted: 0 },
    select: { id: true, mcc_id: true, mcc_name: true, currency: true },
    orderBy: { created_at: "asc" },
  });
  if (mccAccounts.length === 0) return [];

  // 库内 cost（USD）按 MCC 归集 + CNY MCC 按当日汇率反算原币
  const costRows = await prisma.$queryRawUnsafe<{
    mcc_id: bigint | null;
    cost_usd: number;
    cost_cny: number;
  }[]>(`
    SELECT
      c.mcc_id,
      SUM(CAST(s.cost AS DECIMAL(16,6))) AS cost_usd,
      SUM(
        CASE WHEN e.rate_to_usd IS NOT NULL AND e.rate_to_usd > 0
             THEN CAST(s.cost AS DECIMAL(16,6)) / e.rate_to_usd
             ELSE 0 END
      ) AS cost_cny
    FROM ads_daily_stats s
    JOIN campaigns c ON c.id = s.campaign_id
    LEFT JOIN exchange_rate_snapshots e ON e.currency = 'CNY' AND e.date = s.date
    WHERE s.user_id = ? AND s.is_deleted = 0
      AND s.date >= ? AND s.date < ?
    GROUP BY c.mcc_id
  `, userId, dateColumnStart(monthStart), dateColumnStart(monthEnd));

  const costByMcc = new Map<string, { usd: number; cny: number }>();
  for (const row of costRows) {
    if (row.mcc_id == null) {
      if (Number(row.cost_usd || 0) > 0) warnings.push(`有 $${r2(Number(row.cost_usd))} 广告费未关联 MCC，未计入 MCC 段`);
      continue;
    }
    costByMcc.set(String(row.mcc_id), { usd: Number(row.cost_usd || 0), cny: Number(row.cost_cny || 0) });
  }

  const adjustments = await prisma.mcc_cost_adjustments.findMany({
    where: { user_id: userId, month, is_deleted: 0 },
  });
  const adjustMap = new Map(adjustments.map((a) => [String(a.mcc_account_id), Number(a.amount)]));

  const sections: MccSection[] = [];
  for (const mcc of mccAccounts) {
    const dbId = String(mcc.id);
    const cost = costByMcc.get(dbId) || { usd: 0, cny: 0 };
    const adj = adjustMap.get(dbId) || 0; // 补差额（USD 口径，与数据中心一致）
    const isCny = mcc.currency === "CNY";

    const costUsd = r2(cost.usd + adj);
    const costOriginal = isCny
      ? r2(cost.cny + (rate.cnyToUsd > 0 ? adj / rate.cnyToUsd : 0))
      : costUsd;

    const ov = overrides.get(`mcc:${dbId}`);
    const override = ov !== undefined ? r2(ov) : null;
    const effectiveOriginal = override ?? costOriginal;
    const effectiveUsd = override != null
      ? (isCny ? r2(override * rate.cnyToUsd) : override)
      : costUsd;

    // 当月无消耗且无覆盖的 MCC 不出段（保持表干净）
    if (costUsd === 0 && costOriginal === 0 && override == null) continue;

    sections.push({
      mccDbId: dbId,
      mccId: mcc.mcc_id,
      mccName: mcc.mcc_name || mcc.mcc_id,
      currency: mcc.currency,
      adjustment: r2(adj),
      costUsd,
      costOriginal,
      override,
      effectiveOriginal,
      effectiveUsd,
    });
  }
  return sections;
}

// ─────────────────────────────────────────────────────────────
// 组长总计表
// ─────────────────────────────────────────────────────────────

export async function buildTeamMonthlySummary(
  teamId: bigint,
  leaderUserId: bigint,
  month: string,
): Promise<TeamMonthlySummary & { memberReports: MemberMonthlyReport[] }> {
  const members = await prisma.users.findMany({
    where: { team_id: teamId, is_deleted: 0, role: "user" },
    select: { id: true, username: true, display_name: true },
    orderBy: { username: "asc" },
  });

  const rate = await getReportRate(month);
  const currentMonth = nowCST().format("YYYY-MM");
  const isCurrentMonth = month >= currentMonth;
  const warnings: string[] = [];

  // 串行构建（低配服务器，避免并发压库）
  const memberReports: MemberMonthlyReport[] = [];
  for (const m of members) {
    const rep = await buildMemberMonthlyReport(m.id, month);
    memberReports.push(rep);
    for (const w of rep.warnings) warnings.push(`${rep.displayName}: ${w}`);
  }

  // 平台级聚合
  const platMap = new Map<string, TeamPlatformAgg>();
  for (const rep of memberReports) {
    for (const col of rep.accounts) {
      let agg = platMap.get(col.platform);
      if (!agg) {
        agg = { platform: col.platform, book: 0, rejected: 0, recvH1: 0, recvH2: 0, recvTotal: 0, paidH1: 0, paidH2: 0, paidTotal: 0 };
        platMap.set(col.platform, agg);
      }
      agg.book += col.book;
      agg.rejected += col.rejected;
      agg.recvH1 += col.recvH1;
      agg.recvH2 += col.recvH2;
      agg.paidH1 += col.paidH1Effective;
      agg.paidH2 += col.paidH2Effective;
    }
  }
  const platforms = [...platMap.values()]
    .map((a) => ({
      ...a,
      book: r2(a.book), rejected: r2(a.rejected),
      recvH1: r2(a.recvH1), recvH2: r2(a.recvH2), recvTotal: r2(a.recvH1 + a.recvH2),
      paidH1: r2(a.paidH1), paidH2: r2(a.paidH2), paidTotal: r2(a.paidH1 + a.paidH2),
    }))
    .sort((x, y) => {
      const ix = REPORT_PLATFORM_ORDER.indexOf(x.platform);
      const iy = REPORT_PLATFORM_ORDER.indexOf(y.platform);
      return (ix === -1 ? 99 : ix) - (iy === -1 ? 99 : iy);
    });

  const totals = {
    book: r2(memberReports.reduce((s, r) => s + r.totals.book, 0)),
    rejected: r2(memberReports.reduce((s, r) => s + r.totals.rejected, 0)),
    recvH1: r2(memberReports.reduce((s, r) => s + r.totals.recvH1, 0)),
    recvH2: r2(memberReports.reduce((s, r) => s + r.totals.recvH2, 0)),
    recvTotal: 0,
    paidH1: r2(memberReports.reduce((s, r) => s + r.totals.paidH1, 0)),
    paidH2: r2(memberReports.reduce((s, r) => s + r.totals.paidH2, 0)),
    paidTotal: 0,
  };
  totals.recvTotal = r2(totals.recvH1 + totals.recvH2);
  totals.paidTotal = r2(totals.paidH1 + totals.paidH2);

  const adCostTotalUsd = r2(memberReports.reduce((s, r) => s + r.adCostTotalUsd, 0));
  const adCostTotalCny = r2(memberReports.reduce((s, r) => s + r.adCostTotalCny, 0));
  // 组长口径：USD 广告费折 CNY + CNY 广告费累计
  const profitAdCostCny = rate.usdToCny > 0
    ? r2(adCostTotalUsd * rate.usdToCny + adCostTotalCny)
    : 0;

  const enabledCampaigns = memberReports.reduce((s, r) => s + r.enabledCampaigns, 0);

  const paidUsdTotal = totals.paidTotal;
  const estimatedPaidCny = rate.usdToCny > 0 ? r2(paidUsdTotal * rate.usdToCny) : 0;

  // 实际佣金(CNY)：组长手填（存组长 user_id × 月，scope=actual_cny）
  const actualRow = await prisma.report_overrides.findFirst({
    where: { user_id: leaderUserId, month, scope_key: "actual_cny", is_deleted: 0 },
  });
  const actualPaidCny = actualRow ? Number(actualRow.value) : null;

  const profitCny = r2((actualPaidCny ?? estimatedPaidCny) - profitAdCostCny);

  return {
    month,
    teamId: String(teamId),
    generatedAt: nowCST().format("YYYY-MM-DD HH:mm:ss"),
    isCurrentMonth,
    rate,
    members: members.map((m) => ({
      userId: String(m.id),
      username: m.username,
      displayName: m.display_name || m.username,
    })),
    platforms,
    adCostTotalUsd,
    adCostTotalCny,
    profitAdCostCny,
    enabledCampaigns,
    totals,
    paidUsdTotal,
    estimatedPaidCny,
    actualPaidCny,
    profitCny,
    warnings,
    memberReports,
  };
}
