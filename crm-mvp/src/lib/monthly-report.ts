/**
 * R-02 月度收支报表 — 统一视图模型构建器
 *
 * 组员单月表 / 组长全员表 / 组长总计表 / xlsx 导出 全部走本模块，杜绝口径漂移。
 * 全部库内数据，绝不调联盟平台 API。
 *
 * 口径（2026-07-03 拍板）：
 * - 账面佣金 = 当月全部 status 交易佣金；失效 = rejected；按交易发生月归
 *   （复用 report-metrics 的平台后台时间口径）
 * - 应收/实收都按 affiliate_payments.request_date 归月归半月；半月按请求日就近归批：
 *   ≤10号 归 5号批(上半月)，>10号 归 15号批(下半月)——平台请求日有 4-6号 / 14-16号 漂移（2026-07 拍板），
 *   应收计 status IN ('paid','processing')（打款单已生成即应收，含审核中），
 *   实收只计 status='paid'（rejected 忽略）——LB 商家佣金单审核期内为 processing
 * - 应收 = 平台显示金额 amount；实收 = 毛额优先回退净额（paymentDisplayAmount），可手工纠正
 * - 广告费 = ads_daily_stats.cost(USD) 按 campaigns.mcc_id×月归集；
 *   覆盖值优先，无覆盖用 库内cost + mcc_cost_adjustments 补差额；
 *   CNY MCC 按当日汇率快照反算原币展示
 * - 汇率：当月实时（最新快照），历史月锁当月最后一日快照；报表头显示汇率日期
 * - 动态列按 平台+trim(账号名) 去重合并；同平台多账号用 平台1/平台2 后缀
 * - 收款方式：当月读实时绑定；历史月首次访问懒固化到 payment_binding_snapshots
 */

import prisma from "@/lib/prisma";
import { sqlTxnRange, sqlTxnMonth, REPORT_PLATFORM_ORDER, paymentDisplayAmount } from "@/lib/report-metrics";
import { nowCST, dateColumnStart } from "@/lib/date-utils";
import { apportionFee } from "@/lib/bank-flow-fee";

/** 半月归批分界：请求日 ≤10号 归 5号批(H1)，>10号 归 15号批(H2)。
 *  平台名义 5号/15号 分两期请求打款，实际有 4-6号 / 14-16号 漂移，按就近原则判批。 */
export const HALF_SPLIT_DAY = 10;

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
  /** 账面佣金手工纠正（scope book:{platform}:{account}，null = 无） */
  bookOverride: number | null;
  bookEffective: number;
  /** 失效佣金（USD，rejected） */
  rejected: number;
  /** 失效佣金手工纠正（scope rejected:{platform}:{account}） */
  rejectedOverride: number | null;
  rejectedEffective: number;
  /** 应收上/下半月（平台显示金额 amount） */
  recvH1: number;
  recvH2: number;
  /** 应收手工纠正（scope due:{platform}:{account}:{H1|H2}） */
  recvH1Override: number | null;
  recvH2Override: number | null;
  recvH1Effective: number;
  recvH2Effective: number;
  /** 实收上/下半月（毛额优先回退净额，库内计算值） */
  paidH1: number;
  paidH2: number;
  /** 实收手工纠正（null = 无纠正） */
  paidH1Override: number | null;
  paidH2Override: number | null;
  /** 实收生效值（override ?? 计算值） */
  paidH1Effective: number;
  paidH2Effective: number;
  /** 实收(CNY) 默认值：优先取银行流水登记净额（该员工明细金额 − 分摊手续费）；
   *  无流水登记时逐笔按打款日（request_date）当日或其前最近汇率快照折算；
   *  若实收 USD 被手工纠正，则汇率估算改为 纠正值 × 报表汇率 */
  paidCnyH1: number;
  paidCnyH2: number;
  /** 实收(CNY) 手填（scope recvcny:{platform}:{account}:{H1|H2}，null = 未填） */
  paidCnyH1Override: number | null;
  paidCnyH2Override: number | null;
  /** 实收(CNY) 生效值（手填 ?? 默认） */
  paidCnyH1Effective: number;
  paidCnyH2Effective: number;
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
    /** 实收(CNY) 合计（各账号生效值累计） */
    paidCnyH1: number;
    paidCnyH2: number;
    paidCnyTotal: number;
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
  /** R-04.4：每平台实收(CNY)组长手填（scope team_paid_cny:{平台}:{H1|H2}），null=未填 */
  paidCnyH1: number | null;
  paidCnyH2: number | null;
  /** R-07：银行流水登记的实际入账(CNY)聚合（平台×半月，txn_at 北京时间归半月），null=该半月无登记。
   *  实际佣金取值优先级：组长手填 > 银行流水 > 成员默认CNY */
  bankCnyH1: number | null;
  bankCnyH2: number | null;
  /** 该平台成员实收(CNY)生效值累计（逐笔打款日汇率 + 组员手填），手填为空时的默认展示值 */
  memberCnyH1: number;
  memberCnyH2: number;
  /** 该平台实收(CNY)默认合计 = memberCnyH1 + memberCnyH2 */
  estPaidCny: number;
  /** R-04.5：该平台涉及的收款人及其卡号（多卡同人合并），供总计表导出 */
  payees: { name: string; cards: string[] }[];
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
  estimatedPaidCny: number; // 默认实收(CNY) = 成员实收CNY生效值累计（逐笔打款日汇率）
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

/**
 * 月平均汇率（USD→CNY）：当月全部每日快照的算术平均（当月进行中 = 截至今日的平均）。
 * 用于导出报表的人民币→美金统一换算（R-09）。无快照时回退报表统一汇率。
 */
export async function getMonthlyAvgUsdToCny(month: string): Promise<number> {
  const snaps = await prisma.exchange_rate_snapshots.findMany({
    where: {
      currency: "CNY",
      date: { gte: dateColumnStart(`${month}-01`), lt: dateColumnStart(nextMonthStart(month)) },
    },
    select: { rate_to_usd: true },
  });
  const rates = snaps
    .map((s) => Number(s.rate_to_usd))
    .filter((r) => r > 0)
    .map((r) => 1 / r);
  if (rates.length === 0) {
    return (await getReportRate(month)).usdToCny;
  }
  return rates.reduce((s, r) => s + r, 0) / rates.length;
}

/**
 * 打款日汇率查找器：取目标日当日或其前最近的 CNY 快照，返回 usdToCny。
 * 一次查询覆盖整月 + 向前回溯（周末/缺口用之前最近一天）。
 */
async function buildDailyUsdToCnyLookup(endExcl: string, take = 70): Promise<(d: Date) => number> {
  const snaps = await prisma.exchange_rate_snapshots.findMany({
    where: { currency: "CNY", date: { lt: dateColumnStart(endExcl) } },
    orderBy: { date: "desc" },
    take, // 默认覆盖当月 31 天 + 前月回溯
    select: { date: true, rate_to_usd: true },
  });
  const list = snaps.map((s) => ({
    key: s.date.toISOString().slice(0, 10),
    usdToCny: Number(s.rate_to_usd) > 0 ? 1 / Number(s.rate_to_usd) : 0,
  }));
  return (d: Date) => {
    const key = d.toISOString().slice(0, 10);
    for (const s of list) {
      if (s.key <= key) return s.usdToCny;
    }
    return 0;
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
      select: { id: true, username: true, display_name: true, team_id: true },
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
        book: 0, bookOverride: null, bookEffective: 0,
        rejected: 0, rejectedOverride: null, rejectedEffective: 0,
        recvH1: 0, recvH2: 0,
        recvH1Override: null, recvH2Override: null,
        recvH1Effective: 0, recvH2Effective: 0,
        paidH1: 0, paidH2: 0,
        paidH1Override: null, paidH2Override: null,
        paidH1Effective: 0, paidH2Effective: 0,
        paidCnyH1: 0, paidCnyH2: 0,
        paidCnyH1Override: null, paidCnyH2Override: null,
        paidCnyH1Effective: 0, paidCnyH2Effective: 0,
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
      book: o.book, bookOverride: null, bookEffective: o.book,
      rejected: o.rejected, rejectedOverride: null, rejectedEffective: o.rejected,
      recvH1: 0, recvH2: 0,
      recvH1Override: null, recvH2Override: null,
      recvH1Effective: 0, recvH2Effective: 0,
      paidH1: 0, paidH2: 0,
      paidH1Override: null, paidH2Override: null,
      paidH1Effective: 0, paidH2Effective: 0,
      paidCnyH1: 0, paidCnyH2: 0,
      paidCnyH1Override: null, paidCnyH2Override: null,
      paidCnyH1Effective: 0, paidCnyH2Effective: 0,
      payeeName: "", cardNo: "", hasPayments: false,
    });
  }

  // ── 3. 应收/实收（打款记录按 request_date 归半月；应收含审核中，实收只计 paid） ──────
  const payments = await prisma.affiliate_payments.findMany({
    where: {
      user_id: userId,
      is_deleted: 0,
      status: { in: ["paid", "processing"] },
      request_date: { gte: new Date(`${monthStart}T00:00:00Z`), lt: new Date(`${monthEnd}T00:00:00Z`) },
    },
    select: {
      platform: true, platform_connection_id: true, status: true,
      request_date: true, amount: true, gross_amount: true,
    },
  });

  const dailyUsdToCny = await buildDailyUsdToCnyLookup(monthEnd);

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
    const isPaid = p.status === "paid";
    const paid = isPaid
      ? paymentDisplayAmount(Number(p.amount || 0), p.gross_amount == null ? null : Number(p.gross_amount))
      : 0;
    // 实收 CNY 默认值：逐笔按打款日（当日或其前最近快照）汇率折算
    const paidCny = isPaid ? paid * dailyUsdToCny(p.request_date!) : 0;
    if (day <= HALF_SPLIT_DAY) {
      col.recvH1 += recv;
      col.paidH1 += paid;
      col.paidCnyH1 += paidCny;
    } else {
      col.recvH2 += recv;
      col.paidH2 += paid;
      col.paidCnyH2 += paidCny;
    }
  }

  // ── 3b. 银行流水净额（R-07）：有流水登记时，员工实收(CNY)默认值改用
  //        流水明细中该员工金额 − 按比例分摊的手续费（净到手），
  //        替代打款日汇率毛额估算；组员手填 recvcny:* 仍最优先 ──────────
  const bankNetForCol = new Map<ColKey, { H1?: number; H2?: number }>();
  if (user.team_id) {
    const bankEntries = await prisma.bank_flow_entries.findMany({
      where: { team_id: user.team_id, month, is_deleted: 0 },
      select: { platform: true, txn_at: true, amount: true, fee: true, source_date: true, breakdown: true },
    });
    if (bankEntries.length > 0) {
      const teamMembers = await prisma.users.findMany({
        where: { team_id: user.team_id, is_deleted: 0, role: "user" },
        select: { id: true },
      });
      const resolveHalf = await buildBankHalfResolver(bankEntries, teamMembers.map((m) => m.id));
      for (const e of bankEntries) {
        let items: { userId?: unknown; account?: unknown; amount?: unknown }[] = [];
        try { items = e.breakdown ? JSON.parse(e.breakdown) : []; } catch { /* 脏数据跳过 */ }
        if (!Array.isArray(items) || items.length === 0) continue;
        const fees = apportionFee(items.map((i) => Number(i.amount || 0)), Number(e.fee || 0));
        const half = resolveHalf(e);
        items.forEach((it, idx) => {
          if (String(it.userId ?? "") !== String(userId)) return;
          const net = Number(it.amount || 0) - fees[idx];
          // 账号列归属：平台+账号名精确匹配，匹配不到归该平台第一列
          const acct = String(it.account ?? "").trim();
          let key: ColKey = `${e.platform}\u0000${acct}`;
          if (!colByKey.has(key)) {
            const alt = [...colByKey.keys()].find((k) => k.startsWith(`${e.platform}\u0000`));
            if (!alt) return;
            key = alt;
          }
          let slot = bankNetForCol.get(key);
          if (!slot) { slot = {}; bankNetForCol.set(key, slot); }
          slot[half] = (slot[half] || 0) + net;
          colByKey.get(key)!.hasPayments = true;
        });
      }
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
    // 账面/失效/应收手工纠正
    const ovBook = overrides.get(`book:${col.platform}:${col.accountName}`);
    col.bookOverride = ovBook !== undefined ? r2(ovBook) : null;
    col.bookEffective = col.bookOverride ?? col.book;
    const ovRej = overrides.get(`rejected:${col.platform}:${col.accountName}`);
    col.rejectedOverride = ovRej !== undefined ? r2(ovRej) : null;
    col.rejectedEffective = col.rejectedOverride ?? col.rejected;
    const ovDueH1 = overrides.get(`due:${col.platform}:${col.accountName}:H1`);
    const ovDueH2 = overrides.get(`due:${col.platform}:${col.accountName}:H2`);
    col.recvH1Override = ovDueH1 !== undefined ? r2(ovDueH1) : null;
    col.recvH2Override = ovDueH2 !== undefined ? r2(ovDueH2) : null;
    col.recvH1Effective = col.recvH1Override ?? col.recvH1;
    col.recvH2Effective = col.recvH2Override ?? col.recvH2;
    const ovH1 = overrides.get(`recv:${col.platform}:${col.accountName}:H1`);
    const ovH2 = overrides.get(`recv:${col.platform}:${col.accountName}:H2`);
    col.paidH1Override = ovH1 !== undefined ? r2(ovH1) : null;
    col.paidH2Override = ovH2 !== undefined ? r2(ovH2) : null;
    col.paidH1Effective = col.paidH1Override ?? col.paidH1;
    col.paidH2Effective = col.paidH2Override ?? col.paidH2;
    // 实收(CNY)：USD 被纠正时默认改按 纠正值×报表汇率；再套手填覆盖
    col.paidCnyH1 = r2(col.paidH1Override != null ? col.paidH1Override * rate.usdToCny : col.paidCnyH1);
    col.paidCnyH2 = r2(col.paidH2Override != null ? col.paidH2Override * rate.usdToCny : col.paidCnyH2);
    // 银行流水净额优先于估算/USD纠正推导（是真实到手金额）；组员手填仍最优先
    const bankNet = bankNetForCol.get(`${col.platform}\u0000${col.accountName}`);
    if (bankNet?.H1 != null) col.paidCnyH1 = r2(bankNet.H1);
    if (bankNet?.H2 != null) col.paidCnyH2 = r2(bankNet.H2);
    const ovCnyH1 = overrides.get(`recvcny:${col.platform}:${col.accountName}:H1`);
    const ovCnyH2 = overrides.get(`recvcny:${col.platform}:${col.accountName}:H2`);
    col.paidCnyH1Override = ovCnyH1 !== undefined ? r2(ovCnyH1) : null;
    col.paidCnyH2Override = ovCnyH2 !== undefined ? r2(ovCnyH2) : null;
    col.paidCnyH1Effective = col.paidCnyH1Override ?? col.paidCnyH1;
    col.paidCnyH2Effective = col.paidCnyH2Override ?? col.paidCnyH2;
    // 无打款记录时应收/实收留空，员工可手填——不再生成提示（否则年度页警告刷屏）
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
    book: r2(accounts.reduce((s, c) => s + c.bookEffective, 0)),
    rejected: r2(accounts.reduce((s, c) => s + c.rejectedEffective, 0)),
    recvH1: r2(accounts.reduce((s, c) => s + c.recvH1Effective, 0)),
    recvH2: r2(accounts.reduce((s, c) => s + c.recvH2Effective, 0)),
    recvTotal: 0,
    paidH1: r2(accounts.reduce((s, c) => s + c.paidH1Effective, 0)),
    paidH2: r2(accounts.reduce((s, c) => s + c.paidH2Effective, 0)),
    paidTotal: 0,
    paidCnyH1: r2(accounts.reduce((s, c) => s + c.paidCnyH1Effective, 0)),
    paidCnyH2: r2(accounts.reduce((s, c) => s + c.paidCnyH2Effective, 0)),
    paidCnyTotal: 0,
  };
  totals.recvTotal = r2(totals.recvH1 + totals.recvH2);
  totals.paidTotal = r2(totals.paidH1 + totals.paidH2);
  totals.paidCnyTotal = r2(totals.paidCnyH1 + totals.paidCnyH2);

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

    // R-04.1：零消耗 MCC 也出段——早期月份库内无数据时组员可直接手填广告费
    // （手填只写 report_overrides，不影响任何其他数据）

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
// 银行流水归半月（R-07）
// 流水核对按 paid_date 走（prefill），但并入报表时半月必须按「请求时间」口径：
// 通过 source_date（平台显示打款日）反查该批打款单的 request_date 判批。
//
// R-09 修复（2026-07-13，6月对账发现"默认实收"多算 ~5.7 万）：
// 1) 旧版按 paid_date 精确等值反查批次，PM 等平台 paid_date 带时分秒导致反查失败，
//    回退"到账日就近"把 5号批(H1) 的钱判进 H2——上半月汇率估算未被替换、下半月
//    又计银行净额，同一笔钱双计。现改为只比对 paid_date 的日期部分。
// 2) 手工登记的流水（无 source_date）旧版只能按到账日就近兜底，5号批实际 16号前后
//    才到账，同样误判 H2。现改为在到账日 ±7 天窗口内、限定明细涉及的员工，
//    反查打款单请求日按金额占比判批；反查不到才落回日期就近兜底。
// ─────────────────────────────────────────────────────────────

type BankEntryLite = {
  platform: string;
  txn_at: Date;
  amount: unknown;
  source_date: Date | null;
  breakdown?: string | null;
};

/**
 * 构建流水归半月解析器：一次性拉取相关打款单，返回同步判批函数。
 * 判批优先级：批次日(source_date)反查 > 到账日±7天窗口（限明细员工）反查 > 日期就近兜底。
 */
async function buildBankHalfResolver(
  entries: BankEntryLite[],
  memberIds: bigint[],
): Promise<(e: BankEntryLite) => "H1" | "H2"> {
  // 兜底：按打款/到账日就近（5号批顺延最晚 ~13号入账，15号批最早 ~16号）
  const dayHeuristic = (e: BankEntryLite): "H1" | "H2" => {
    const base = e.source_date ?? e.txn_at;
    const day = new Date(base.getTime() + 8 * 3600 * 1000).getUTCDate();
    return day <= 13 ? "H1" : "H2";
  };
  if (entries.length === 0 || memberIds.length === 0) return dayHeuristic;

  const DAY = 86400000;
  let minT = Infinity;
  let maxT = -Infinity;
  for (const e of entries) {
    const times = [e.txn_at.getTime()];
    if (e.source_date) times.push(e.source_date.getTime());
    for (const t of times) {
      if (t < minT) minT = t;
      if (t > maxT) maxT = t;
    }
  }
  const rows = await prisma.affiliate_payments.findMany({
    where: {
      user_id: { in: memberIds }, is_deleted: 0,
      status: { in: ["paid", "processing"] },
      platform: { in: [...new Set(entries.map((e) => e.platform))] },
      paid_date: { gte: new Date(minT - 8 * DAY), lt: new Date(maxT + 9 * DAY) },
    },
    select: { platform: true, paid_date: true, request_date: true, amount: true, user_id: true },
  });
  type PayRow = { userId: string; paidDay: string; paidTime: number; half: "H1" | "H2"; amount: number };
  const byPlatform = new Map<string, PayRow[]>();
  for (const r of rows) {
    if (!r.paid_date || !r.request_date) continue;
    let list = byPlatform.get(r.platform);
    if (!list) { list = []; byPlatform.set(r.platform, list); }
    const paidDay = r.paid_date.toISOString().slice(0, 10);
    list.push({
      userId: String(r.user_id),
      paidDay,
      paidTime: new Date(`${paidDay}T00:00:00Z`).getTime(),
      half: r.request_date.getUTCDate() <= HALF_SPLIT_DAY ? "H1" : "H2",
      amount: Number(r.amount || 0),
    });
  }
  const dominant = (list: PayRow[]): "H1" | "H2" | null => {
    if (list.length === 0) return null;
    let h1 = 0, h2 = 0;
    for (const r of list) {
      if (r.half === "H1") h1 += r.amount;
      else h2 += r.amount;
    }
    return h1 >= h2 ? "H1" : "H2";
  };

  return (e: BankEntryLite): "H1" | "H2" => {
    const list = byPlatform.get(e.platform) || [];
    // 1) 有批次日：该批（platform×打款日）打款单请求日按金额占比判批（只比日期部分）
    if (e.source_date) {
      const key = e.source_date.toISOString().slice(0, 10);
      const h = dominant(list.filter((r) => r.paidDay === key));
      if (h) return h;
    }
    // 2) 到账日 ±7 天窗口，限定流水明细涉及的员工
    let userIds: Set<string> | null = null;
    if (e.breakdown) {
      try {
        const items = JSON.parse(e.breakdown) as { userId?: unknown }[];
        if (Array.isArray(items) && items.length > 0) {
          userIds = new Set(items.map((i) => String(i.userId ?? "")));
        }
      } catch { /* 脏数据忽略，退化为全员窗口 */ }
    }
    const baseT = (e.source_date ?? e.txn_at).getTime();
    const h = dominant(list.filter(
      (r) => Math.abs(r.paidTime - baseT) <= 7 * DAY && (!userIds || userIds.has(r.userId)),
    ));
    if (h) return h;
    return dayHeuristic(e);
  };
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
        agg = {
          platform: col.platform, book: 0, rejected: 0, recvH1: 0, recvH2: 0, recvTotal: 0,
          paidH1: 0, paidH2: 0, paidTotal: 0,
          paidCnyH1: null, paidCnyH2: null, bankCnyH1: null, bankCnyH2: null,
          memberCnyH1: 0, memberCnyH2: 0, estPaidCny: 0, payees: [],
        };
        platMap.set(col.platform, agg);
      }
      agg.book += col.bookEffective;
      agg.rejected += col.rejectedEffective;
      agg.recvH1 += col.recvH1Effective;
      agg.recvH2 += col.recvH2Effective;
      agg.paidH1 += col.paidH1Effective;
      agg.paidH2 += col.paidH2Effective;
      agg.memberCnyH1 += col.paidCnyH1Effective;
      agg.memberCnyH2 += col.paidCnyH2Effective;
    }
  }

  // R-07：银行流水登记的实际入账(CNY)，按 平台×半月 聚合。
  // 归半月用「请求时间」口径与报表其余列一致：通过 source_date（平台显示打款日）反查
  // 该批打款单的 request_date 判批（≤10号 = 5号批 H1，>10号 = 15号批 H2）；
  // 反查不到时才退回到账日就近判断。银行流水核对本身仍按 paid_date 走（prefill 不变）。
  const bankEntries = await prisma.bank_flow_entries.findMany({
    where: { team_id: teamId, month, is_deleted: 0 },
    select: { platform: true, txn_at: true, amount: true, source_date: true, breakdown: true },
  });
  const resolveTeamBankHalf = await buildBankHalfResolver(bankEntries, members.map((m) => m.id));
  const bankCnyByPlat = new Map<string, { H1: number; H2: number; hasH1: boolean; hasH2: boolean }>();
  for (const e of bankEntries) {
    const half = resolveTeamBankHalf(e);
    let b = bankCnyByPlat.get(e.platform);
    if (!b) { b = { H1: 0, H2: 0, hasH1: false, hasH2: false }; bankCnyByPlat.set(e.platform, b); }
    if (half === "H1") { b.H1 += Number(e.amount || 0); b.hasH1 = true; }
    else { b.H2 += Number(e.amount || 0); b.hasH2 = true; }
  }
  // 银行流水可能涉及成员报表里没有的平台列（如历史账号已删），补一列空聚合避免金额丢失
  for (const plat of bankCnyByPlat.keys()) {
    if (!platMap.has(plat)) {
      platMap.set(plat, {
        platform: plat, book: 0, rejected: 0, recvH1: 0, recvH2: 0, recvTotal: 0,
        paidH1: 0, paidH2: 0, paidTotal: 0,
        paidCnyH1: null, paidCnyH2: null, bankCnyH1: null, bankCnyH2: null,
        memberCnyH1: 0, memberCnyH2: 0, estPaidCny: 0, payees: [],
      });
    }
  }

  // R-04.4：组长手填的每平台实收(CNY) + 旧版总额 actual_cny（兼容）
  const leaderOverrides = await prisma.report_overrides.findMany({
    where: {
      user_id: leaderUserId, month, is_deleted: 0,
      OR: [{ scope_key: "actual_cny" }, { scope_key: { startsWith: "team_paid_cny:" } }],
    },
  });
  const platCnyManual = new Map<string, { H1?: number; H2?: number }>();
  let legacyActualCny: number | null = null;
  for (const o of leaderOverrides) {
    if (o.scope_key === "actual_cny") { legacyActualCny = Number(o.value); continue; }
    const m = o.scope_key.match(/^team_paid_cny:([^:]+):(H1|H2)$/);
    if (!m) continue;
    const entry = platCnyManual.get(m[1]) || {};
    entry[m[2] as "H1" | "H2"] = Number(o.value);
    platCnyManual.set(m[1], entry);
  }

  // R-04.5：每平台涉及的收款人→卡号集合（供总计表"收款人分开、多卡同格"展示）
  const payeeByPlatform = new Map<string, Map<string, Set<string>>>();
  for (const rep of memberReports) {
    for (const col of rep.accounts) {
      if (!col.payeeName) continue;
      let byName = payeeByPlatform.get(col.platform);
      if (!byName) { byName = new Map(); payeeByPlatform.set(col.platform, byName); }
      let cards = byName.get(col.payeeName);
      if (!cards) { cards = new Set(); byName.set(col.payeeName, cards); }
      if (col.cardNo) cards.add(col.cardNo);
    }
  }

  const platforms = [...platMap.values()]
    .map((a) => {
      const manual = platCnyManual.get(a.platform) || {};
      const bank = bankCnyByPlat.get(a.platform);
      const paidH1 = r2(a.paidH1), paidH2 = r2(a.paidH2);
      const memberCnyH1 = r2(a.memberCnyH1), memberCnyH2 = r2(a.memberCnyH2);
      const byName = payeeByPlatform.get(a.platform);
      return {
        ...a,
        book: r2(a.book), rejected: r2(a.rejected),
        recvH1: r2(a.recvH1), recvH2: r2(a.recvH2), recvTotal: r2(a.recvH1 + a.recvH2),
        paidH1, paidH2, paidTotal: r2(paidH1 + paidH2),
        paidCnyH1: manual.H1 != null ? r2(manual.H1) : null,
        paidCnyH2: manual.H2 != null ? r2(manual.H2) : null,
        bankCnyH1: bank?.hasH1 ? r2(bank.H1) : null,
        bankCnyH2: bank?.hasH2 ? r2(bank.H2) : null,
        memberCnyH1, memberCnyH2,
        estPaidCny: r2(memberCnyH1 + memberCnyH2),
        payees: byName
          ? [...byName.entries()]
              .map(([name, cards]) => ({ name, cards: [...cards].sort() }))
              .sort((x, y) => x.name.localeCompare(y.name, "zh"))
          : [],
      };
    })
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
    paidCnyH1: r2(memberReports.reduce((s, r) => s + r.totals.paidCnyH1, 0)),
    paidCnyH2: r2(memberReports.reduce((s, r) => s + r.totals.paidCnyH2, 0)),
    paidCnyTotal: 0,
  };
  totals.recvTotal = r2(totals.recvH1 + totals.recvH2);
  totals.paidTotal = r2(totals.paidH1 + totals.paidH2);
  totals.paidCnyTotal = r2(totals.paidCnyH1 + totals.paidCnyH2);

  const adCostTotalUsd = r2(memberReports.reduce((s, r) => s + r.adCostTotalUsd, 0));
  const adCostTotalCny = r2(memberReports.reduce((s, r) => s + r.adCostTotalCny, 0));
  // 组长口径：USD 广告费折 CNY + CNY 广告费累计
  const profitAdCostCny = rate.usdToCny > 0
    ? r2(adCostTotalUsd * rate.usdToCny + adCostTotalCny)
    : 0;

  const enabledCampaigns = memberReports.reduce((s, r) => s + r.enabledCampaigns, 0);

  const paidUsdTotal = totals.paidTotal;
  // 默认实收(CNY) = 成员实收CNY生效值累计（逐笔打款日汇率 + 组员手填）
  const estimatedPaidCny = totals.paidCnyTotal;

  // 实际佣金(CNY)：Σ每平台每半月(组长手填 ?? 银行流水登记 ?? 该平台成员默认CNY)；
  // 旧版总额 actual_cny 若存在则整体覆盖（兼容）。
  // R-07 起银行流水登记即自动同步进报表，只有手填/流水都为空时才回落成员默认估算。
  const anyPlatformManual = platforms.some(
    (p) => p.paidCnyH1 != null || p.paidCnyH2 != null || p.bankCnyH1 != null || p.bankCnyH2 != null,
  );
  const actualPaidCny = legacyActualCny != null
    ? legacyActualCny
    : anyPlatformManual
      ? r2(platforms.reduce(
          (s, p) =>
            s + (p.paidCnyH1 ?? p.bankCnyH1 ?? p.memberCnyH1) + (p.paidCnyH2 ?? p.bankCnyH2 ?? p.memberCnyH2),
          0,
        ))
      : null;

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

// ─────────────────────────────────────────────────────────────
// 组长年度报表（R-04.2：整年 × 新口径，替代旧五指标年度视图）
// 直接按月分组 SQL 聚合（不逐员工构建月报，避免 12×N 次全量查询压垮低配库），
// 口径与 buildTeamMonthlySummary 一致：账面/失效按平台后台时间归月；
// 应收/实收按 request_date 归月归半月（实收套用组员手工纠正 recv:*）；
// 广告费含 MCC 补差额与组员覆盖 mcc:*；实际佣金(¥)套用组长手填。
// ─────────────────────────────────────────────────────────────

export interface AnnualMonthAgg {
  month: string;
  rate: { usdToCny: number; date: string; locked: boolean };
  adUsd: number;
  adCny: number;
  profitAdCostCny: number;
  book: number;
  rejected: number;
  recvTotal: number;
  paidTotal: number;
  estPaidCny: number;
  actualPaidCny: number | null;
  profitCny: number;
}

export interface TeamAnnualReport {
  year: number;
  teamId: string;
  generatedAt: string;
  months: AnnualMonthAgg[];
  totals: {
    adUsd: number; adCny: number; profitAdCostCny: number;
    book: number; rejected: number; recvTotal: number; paidTotal: number;
    estPaidCny: number;
    /** Σ每月(实际手填 ?? 预估)，实际佣金年合计口径 */
    effectiveActualCny: number;
    profitCny: number;
  };
  warnings: string[];
}

export async function buildTeamAnnualReport(
  teamId: bigint,
  leaderUserId: bigint,
  year: number,
): Promise<TeamAnnualReport> {
  const warnings: string[] = [];
  const members = await prisma.users.findMany({
    where: { team_id: teamId, is_deleted: 0, role: "user" },
    select: { id: true },
  });
  const memberIds = members.map((m) => m.id);
  const yearStart = `${year}-01-01`;
  const yearEndExcl = `${year + 1}-01-01`;
  const monthsList = Array.from({ length: 12 }, (_, i) => `${year}-${String(i + 1).padStart(2, "0")}`);

  const rates = new Map<string, { cnyToUsd: number; usdToCny: number; date: string; locked: boolean }>();
  for (const m of monthsList) rates.set(m, await getReportRate(m));

  type MonthAcc = {
    adUsd: number; adCny: number; book: number; rejected: number;
    recvTotal: number; paidTotal: number; paidCnyTotal: number;
  };
  const acc = new Map<string, MonthAcc>(
    monthsList.map((m) => [m, { adUsd: 0, adCny: 0, book: 0, rejected: 0, recvTotal: 0, paidTotal: 0, paidCnyTotal: 0 }]),
  );
  /** 每平台×月×半月的默认实收(CNY)（逐笔打款日汇率 + 组员手填），组长手填为空时的兜底 */
  const paidCnyPlatHalf = new Map<string, number>(); // `${month}|${platform}|${H1|H2}`

  // ── 银行流水登记（R-07）：整年一次拉取。归半月同月度口径：source_date 反查批次
  // request_date 判批，兜底按日期就近。用于：
  // a) 月×平台×半月 实际入账(CNY)聚合（实际佣金取值，优先级低于组长手填、高于成员估算）；
  // b) 默认实收(CNY)的净额替换（与月度 3b 一致，杜绝年度/月度口径漂移，见下方替换段）
  const bankRows = await prisma.bank_flow_entries.findMany({
    where: { team_id: teamId, is_deleted: 0, month: { startsWith: `${year}-` } },
    select: { month: true, platform: true, txn_at: true, amount: true, fee: true, source_date: true, breakdown: true },
  });
  const resolveAnnualBankHalf = await buildBankHalfResolver(bankRows, memberIds);
  const bankCnyMonthPlat = new Map<string, Map<string, { H1?: number; H2?: number }>>();
  for (const e of bankRows) {
    const half = resolveAnnualBankHalf(e);
    let byPlat = bankCnyMonthPlat.get(e.month);
    if (!byPlat) { byPlat = new Map(); bankCnyMonthPlat.set(e.month, byPlat); }
    const entry = byPlat.get(e.platform) || {};
    entry[half] = (entry[half] || 0) + Number(e.amount || 0);
    byPlat.set(e.platform, entry);
  }

  if (memberIds.length > 0) {
    const uidIn = memberIds.map(() => "?").join(",");

    // ── 1. 账面/失效佣金（格粒度 user×month×platform×账号，套用 book:/rejected: 手工纠正） ──
    const txnRange = sqlTxnRange("t", yearStart, yearEndExcl);
    const txnRows = await prisma.$queryRawUnsafe<{
      uid: bigint; platform: string; acct: string | null; m: string; book: number; rejected: number;
    }[]>(`
      SELECT t.user_id AS uid, t.platform,
        TRIM(COALESCE(pc.account_name, '')) AS acct,
        ${sqlTxnMonth("t")} AS m,
        SUM(CAST(t.commission_amount AS DECIMAL(14,4))) AS book,
        SUM(CASE WHEN t.status = 'rejected' THEN CAST(t.commission_amount AS DECIMAL(14,4)) ELSE 0 END) AS rejected
      FROM affiliate_transactions t
      LEFT JOIN platform_connections pc ON pc.id = t.platform_connection_id
      WHERE t.user_id IN (${uidIn}) AND t.is_deleted = 0 AND ${txnRange.cond}
      GROUP BY uid, t.platform, acct, m
    `, ...memberIds, ...txnRange.params);
    const bookCells = new Map<string, { book: number; rejected: number }>(); // `${uid}|${m}|${platform}|${acct}`
    for (const r of txnRows) {
      const key = `${r.uid}|${r.m}|${r.platform}|${(r.acct || "").trim()}`;
      const c = bookCells.get(key) || { book: 0, rejected: 0 };
      c.book += Number(r.book || 0);
      c.rejected += Number(r.rejected || 0);
      bookCells.set(key, c);
    }

    // ── 2. 应收/实收（打款按 request_date 归月归半月；应收含审核中 processing，实收只计 paid；按日分组以便逐笔折 CNY） ──
    const payRows = await prisma.$queryRawUnsafe<{
      uid: bigint; platform: string; acct: string | null; d: string; m: string; half: string;
      recv: number; paid: number;
    }[]>(`
      SELECT p.user_id AS uid, p.platform,
        TRIM(COALESCE(pc.account_name, '')) AS acct,
        DATE_FORMAT(p.request_date, '%Y-%m-%d') AS d,
        DATE_FORMAT(p.request_date, '%Y-%m') AS m,
        CASE WHEN DAY(p.request_date) <= ${HALF_SPLIT_DAY} THEN 'H1' ELSE 'H2' END AS half,
        SUM(CAST(p.amount AS DECIMAL(14,4))) AS recv,
        SUM(CAST(CASE WHEN p.status = 'paid'
                 THEN (CASE WHEN p.gross_amount IS NOT NULL AND p.gross_amount > 0 THEN p.gross_amount ELSE p.amount END)
                 ELSE 0 END AS DECIMAL(14,4))) AS paid
      FROM affiliate_payments p
      LEFT JOIN platform_connections pc ON pc.id = p.platform_connection_id
      WHERE p.user_id IN (${uidIn}) AND p.is_deleted = 0 AND p.status IN ('paid','processing')
        AND p.request_date >= ? AND p.request_date < ?
      GROUP BY uid, p.platform, acct, d, m, half
    `, ...memberIds, new Date(`${yearStart}T00:00:00Z`), new Date(`${yearEndExcl}T00:00:00Z`));

    const dailyUsdToCny = await buildDailyUsdToCnyLookup(yearEndExcl, 440);

    // 组员手工纠正：格粒度 user×month×platform×账号(×半月)，覆盖库内计算值
    // book:/rejected: 纠正账面/失效；due:* 纠正应收；
    // recv:* 纠正实收 USD（CNY 默认随之改为 纠正值×当月报表汇率）；recvcny:* 手填实收 CNY
    const memberOv = await prisma.report_overrides.findMany({
      where: {
        user_id: { in: memberIds }, is_deleted: 0,
        month: { startsWith: `${year}-` },
        OR: [
          { scope_key: { startsWith: "recv:" } },
          { scope_key: { startsWith: "recvcny:" } },
          { scope_key: { startsWith: "due:" } },
          { scope_key: { startsWith: "book:" } },
          { scope_key: { startsWith: "rejected:" } },
        ],
      },
    });
    const recvCells = new Map<string, number>(); // `${uid}|${m}|${platform}|${acct}|${half}`
    const paidCells = new Map<string, number>();
    const paidCnyCells = new Map<string, number>();
    for (const r of payRows) {
      const m = String(r.m);
      if (!acc.has(m)) continue;
      const key = `${r.uid}|${m}|${r.platform}|${(r.acct || "").trim()}|${r.half}`;
      recvCells.set(key, (recvCells.get(key) || 0) + Number(r.recv || 0));
      const paid = Number(r.paid || 0);
      paidCells.set(key, (paidCells.get(key) || 0) + paid);
      const cny = paid * dailyUsdToCny(new Date(`${r.d}T00:00:00Z`));
      paidCnyCells.set(key, (paidCnyCells.get(key) || 0) + cny);
    }
    for (const o of memberOv) {
      const cellKey = (p: string, a: string, h?: string) =>
        `${o.user_id}|${o.month}|${p}|${a.trim()}${h ? `|${h}` : ""}`;
      let mch = o.scope_key.match(/^recv:([^:]+):([^:]*):(H1|H2)$/);
      if (mch) {
        const key = cellKey(mch[1], mch[2], mch[3]);
        paidCells.set(key, Number(o.value));
        const rate = rates.get(o.month);
        paidCnyCells.set(key, Number(o.value) * (rate?.usdToCny || 0));
        continue;
      }
      mch = o.scope_key.match(/^due:([^:]+):([^:]*):(H1|H2)$/);
      if (mch) { recvCells.set(cellKey(mch[1], mch[2], mch[3]), Number(o.value)); continue; }
      mch = o.scope_key.match(/^book:([^:]+):([^:]*)$/);
      if (mch) {
        const key = cellKey(mch[1], mch[2]);
        const c = bookCells.get(key) || { book: 0, rejected: 0 };
        c.book = Number(o.value);
        bookCells.set(key, c);
        continue;
      }
      mch = o.scope_key.match(/^rejected:([^:]+):([^:]*)$/);
      if (mch) {
        const key = cellKey(mch[1], mch[2]);
        const c = bookCells.get(key) || { book: 0, rejected: 0 };
        c.rejected = Number(o.value);
        bookCells.set(key, c);
      }
    }
    // ── 银行流水净额替换（C-173，口径对齐月度 3b）：有流水登记的 员工×月×平台×账号×半月，
    // 默认实收(CNY) 改用 流水明细金额 − 按比例分摊手续费（真实净到手），
    // 替代打款日汇率毛额估算（含 recv:* 推导值）；组员手填 recvcny:* 仍最优先（后套） ──
    const memberIdSet = new Set(memberIds.map((id) => String(id)));
    const bankNetCells = new Map<string, number>(); // `${uid}|${m}|${platform}|${acct}|${half}`
    for (const e of bankRows) {
      let items: { userId?: unknown; account?: unknown; amount?: unknown }[] = [];
      try { items = e.breakdown ? JSON.parse(e.breakdown) : []; } catch { /* 脏数据跳过 */ }
      if (!Array.isArray(items) || items.length === 0) continue;
      const fees = apportionFee(items.map((i) => Number(i.amount || 0)), Number(e.fee || 0));
      const half = resolveAnnualBankHalf(e);
      items.forEach((it, idx) => {
        const uid = String(it.userId ?? "");
        if (!memberIdSet.has(uid)) return;
        const net = Number(it.amount || 0) - fees[idx];
        const key = `${uid}|${e.month}|${e.platform}|${String(it.account ?? "").trim()}|${half}`;
        bankNetCells.set(key, (bankNetCells.get(key) || 0) + net);
      });
    }
    // 先把每个净额格解析到目标格（账号名精确匹配不到时，归该 员工×月×平台 已有打款的首个账号），
    // 再按目标格汇总后一次性替换估算值，避免多来源相互覆盖
    const existingKeys = [...paidCnyCells.keys()];
    const resolvedNet = new Map<string, number>();
    for (const [key, net] of bankNetCells) {
      let target = key;
      if (!paidCnyCells.has(target)) {
        const [uid, m, platform, , half] = key.split("|");
        const prefix = `${uid}|${m}|${platform}|`;
        const alt = existingKeys.find((k) => k.startsWith(prefix) && k.endsWith(`|${half}`))
          ?? existingKeys.find((k) => k.startsWith(prefix));
        if (alt) target = `${prefix}${alt.split("|")[3]}|${half}`;
      }
      resolvedNet.set(target, (resolvedNet.get(target) || 0) + net);
    }
    for (const [target, net] of resolvedNet) paidCnyCells.set(target, net);
    // recvcny:* 后套（覆盖 recv:* 推导与银行流水净额的默认 CNY）
    for (const o of memberOv) {
      const mch = o.scope_key.match(/^recvcny:([^:]+):([^:]*):(H1|H2)$/);
      if (!mch) continue;
      paidCnyCells.set(`${o.user_id}|${o.month}|${mch[1]}|${mch[2].trim()}|${mch[3]}`, Number(o.value));
    }
    for (const [key, c] of bookCells) {
      const m = key.split("|")[1];
      const a = acc.get(m);
      if (a) { a.book += c.book; a.rejected += c.rejected; }
    }
    for (const [key, val] of recvCells) {
      const m = key.split("|")[1];
      const a = acc.get(m);
      if (a) a.recvTotal += val;
    }
    for (const [key, val] of paidCells) {
      const m = key.split("|")[1];
      const a = acc.get(m);
      if (a) a.paidTotal += val;
    }
    for (const [key, val] of paidCnyCells) {
      const [, m, platform, , half] = key.split("|");
      const a = acc.get(m);
      if (!a) continue;
      a.paidCnyTotal += val;
      const phKey = `${m}|${platform}|${half}`;
      paidCnyPlatHalf.set(phKey, (paidCnyPlatHalf.get(phKey) || 0) + val);
    }

    // ── 3. 广告费（MCC×月，含补差额与组员覆盖） ──
    const costRows = await prisma.$queryRawUnsafe<{ mcc_id: bigint | null; m: string; usd: number; cny: number }[]>(`
      SELECT c.mcc_id, DATE_FORMAT(s.date, '%Y-%m') AS m,
        SUM(CAST(s.cost AS DECIMAL(16,6))) AS usd,
        SUM(CASE WHEN e.rate_to_usd IS NOT NULL AND e.rate_to_usd > 0
                 THEN CAST(s.cost AS DECIMAL(16,6)) / e.rate_to_usd ELSE 0 END) AS cny
      FROM ads_daily_stats s
      JOIN campaigns c ON c.id = s.campaign_id
      LEFT JOIN exchange_rate_snapshots e ON e.currency = 'CNY' AND e.date = s.date
      WHERE s.user_id IN (${uidIn}) AND s.is_deleted = 0 AND s.date >= ? AND s.date < ?
      GROUP BY c.mcc_id, m
    `, ...memberIds, dateColumnStart(yearStart), dateColumnStart(yearEndExcl));

    const mccMeta = new Map(
      (await prisma.google_mcc_accounts.findMany({
        where: { user_id: { in: memberIds }, is_deleted: 0 },
        select: { id: true, currency: true },
      })).map((m) => [String(m.id), m.currency]),
    );
    const adjustRows = await prisma.mcc_cost_adjustments.findMany({
      where: { user_id: { in: memberIds }, is_deleted: 0, month: { startsWith: `${year}-` } },
    });
    const mccOvRows = await prisma.report_overrides.findMany({
      where: {
        user_id: { in: memberIds }, is_deleted: 0,
        month: { startsWith: `${year}-` }, scope_key: { startsWith: "mcc:" },
      },
    });

    type MccMonth = { usd: number; cny: number; adj: number; ov: number | null };
    const mccMonth = new Map<string, MccMonth>(); // `${mccDbId}|${month}`
    const cell = (k: string): MccMonth => {
      let c = mccMonth.get(k);
      if (!c) { c = { usd: 0, cny: 0, adj: 0, ov: null }; mccMonth.set(k, c); }
      return c;
    };
    for (const r of costRows) {
      if (r.mcc_id == null) {
        if (Number(r.usd || 0) > 0) warnings.push(`${r.m} 有 $${r2(Number(r.usd))} 广告费未关联 MCC，未计入`);
        continue;
      }
      const c = cell(`${r.mcc_id}|${r.m}`);
      c.usd = Number(r.usd || 0);
      c.cny = Number(r.cny || 0);
    }
    for (const a of adjustRows) cell(`${a.mcc_account_id}|${a.month}`).adj = Number(a.amount);
    for (const o of mccOvRows) {
      const id = o.scope_key.slice(4);
      if (mccMeta.has(id)) cell(`${id}|${o.month}`).ov = Number(o.value);
    }
    for (const [key, c] of mccMonth) {
      const [mccId, m] = key.split("|");
      const a = acc.get(m);
      if (!a) continue;
      // 口径对齐月度表：只计成员活跃 MCC（已删 MCC 的历史花费与月度 buildMccSections 一致地不计入）
      if (!mccMeta.has(mccId)) continue;
      const rate = rates.get(m)!;
      const isCny = mccMeta.get(mccId) === "CNY";
      const costUsd = c.usd + c.adj;
      const costOriginal = isCny ? c.cny + (rate.cnyToUsd > 0 ? c.adj / rate.cnyToUsd : 0) : costUsd;
      const effOriginal = c.ov ?? costOriginal;
      const effUsd = c.ov != null ? (isCny ? c.ov * rate.cnyToUsd : c.ov) : costUsd;
      if (isCny) a.adCny += effOriginal;
      else a.adUsd += effUsd;
    }
  }

  // ── 4. 组长手填（每平台 CNY + 旧版总额），按月套用 ──
  const leadOv = await prisma.report_overrides.findMany({
    where: {
      user_id: leaderUserId, is_deleted: 0, month: { startsWith: `${year}-` },
      OR: [{ scope_key: "actual_cny" }, { scope_key: { startsWith: "team_paid_cny:" } }],
    },
  });
  const legacyByMonth = new Map<string, number>();
  const platManualByMonth = new Map<string, Map<string, { H1?: number; H2?: number }>>();
  for (const o of leadOv) {
    if (o.scope_key === "actual_cny") { legacyByMonth.set(o.month, Number(o.value)); continue; }
    const mch = o.scope_key.match(/^team_paid_cny:([^:]+):(H1|H2)$/);
    if (!mch) continue;
    let byPlat = platManualByMonth.get(o.month);
    if (!byPlat) { byPlat = new Map(); platManualByMonth.set(o.month, byPlat); }
    const entry = byPlat.get(mch[1]) || {};
    entry[mch[2] as "H1" | "H2"] = Number(o.value);
    byPlat.set(mch[1], entry);
  }

  // ── 5. 汇总每月 ──
  const months: AnnualMonthAgg[] = monthsList.map((m) => {
    const a = acc.get(m)!;
    const rate = rates.get(m)!;
    const adUsd = r2(a.adUsd);
    const adCny = r2(a.adCny);
    const profitAdCostCny = rate.usdToCny > 0 ? r2(adUsd * rate.usdToCny + adCny) : adCny;
    const paidTotal = r2(a.paidTotal);
    // 默认实收(CNY)：逐笔按打款日汇率折算（含组员手填 CNY）
    const estPaidCny = r2(a.paidCnyTotal);

    const byPlat = platManualByMonth.get(m);
    const bankByPlat = bankCnyMonthPlat.get(m);
    let actualPaidCny: number | null = legacyByMonth.get(m) ?? null;
    if (actualPaidCny == null && ((byPlat && byPlat.size > 0) || (bankByPlat && bankByPlat.size > 0))) {
      // 参与平台 = 有实收的平台 ∪ 有手填的平台 ∪ 有银行流水登记的平台
      const plats = new Set<string>([...(byPlat?.keys() || []), ...(bankByPlat?.keys() || [])]);
      for (const key of paidCnyPlatHalf.keys()) {
        const [pm, plat] = key.split("|");
        if (pm === m) plats.add(plat);
      }
      let sum = 0;
      for (const plat of plats) {
        const manual = byPlat?.get(plat) || {};
        const bank = bankByPlat?.get(plat) || {};
        const estH1 = paidCnyPlatHalf.get(`${m}|${plat}|H1`) || 0;
        const estH2 = paidCnyPlatHalf.get(`${m}|${plat}|H2`) || 0;
        // 优先级：组长手填 > 银行流水登记 > 成员默认估算
        sum += (manual.H1 ?? bank.H1 ?? estH1) + (manual.H2 ?? bank.H2 ?? estH2);
      }
      actualPaidCny = r2(sum);
    }

    const profitCny = r2((actualPaidCny ?? estPaidCny) - profitAdCostCny);
    return {
      month: m,
      rate: { usdToCny: rate.usdToCny, date: rate.date, locked: rate.locked },
      adUsd, adCny, profitAdCostCny,
      book: r2(a.book), rejected: r2(a.rejected),
      recvTotal: r2(a.recvTotal), paidTotal,
      estPaidCny, actualPaidCny, profitCny,
    };
  });

  const totals = {
    adUsd: r2(months.reduce((s, m) => s + m.adUsd, 0)),
    adCny: r2(months.reduce((s, m) => s + m.adCny, 0)),
    profitAdCostCny: r2(months.reduce((s, m) => s + m.profitAdCostCny, 0)),
    book: r2(months.reduce((s, m) => s + m.book, 0)),
    rejected: r2(months.reduce((s, m) => s + m.rejected, 0)),
    recvTotal: r2(months.reduce((s, m) => s + m.recvTotal, 0)),
    paidTotal: r2(months.reduce((s, m) => s + m.paidTotal, 0)),
    estPaidCny: r2(months.reduce((s, m) => s + m.estPaidCny, 0)),
    effectiveActualCny: r2(months.reduce((s, m) => s + (m.actualPaidCny ?? m.estPaidCny), 0)),
    profitCny: r2(months.reduce((s, m) => s + m.profitCny, 0)),
  };

  return {
    year,
    teamId: String(teamId),
    generatedAt: nowCST().format("YYYY-MM-DD HH:mm:ss"),
    months,
    totals,
    warnings,
  };
}

// ─────────────────────────────────────────────────────────────
// 组员个人年度报表（逐月复用 buildMemberMonthlyReport，口径与月报完全一致；
// 每月一行只显示合计，不分上下半月）
// ─────────────────────────────────────────────────────────────

export interface MemberAnnualMonth {
  month: string;
  rate: { usdToCny: number; date: string; locked: boolean };
  adUsd: number;
  adCny: number;
  profitAdCostUsd: number;
  book: number;
  rejected: number;
  recvTotal: number;
  paidTotal: number;
  /** 实收(CNY) 生效值合计（逐笔打款日汇率 + 手填） */
  paidCnyTotal: number;
  profitUsd: number;
  profitCny: number;
}

export interface MemberAnnualReport {
  year: number;
  userId: string;
  username: string;
  displayName: string;
  generatedAt: string;
  months: MemberAnnualMonth[];
  totals: {
    adUsd: number; adCny: number; profitAdCostUsd: number;
    book: number; rejected: number; recvTotal: number;
    paidTotal: number; paidCnyTotal: number;
    profitUsd: number; profitCny: number;
  };
  warnings: string[];
}

export async function buildMemberAnnualReport(
  userId: bigint,
  year: number,
): Promise<MemberAnnualReport> {
  const currentMonth = nowCST().format("YYYY-MM");
  const monthsList = Array.from({ length: 12 }, (_, i) => `${year}-${String(i + 1).padStart(2, "0")}`)
    .filter((m) => m <= currentMonth); // 未到的月份不查

  const warnings: string[] = [];
  const months: MemberAnnualMonth[] = [];
  let username = "", displayName = "";

  if (monthsList.length === 0) {
    const user = await prisma.users.findFirst({
      where: { id: userId, is_deleted: 0 },
      select: { username: true, display_name: true },
    });
    username = user?.username || "";
    displayName = user?.display_name || username;
  }

  // 串行逐月构建（低配服务器，避免并发压库）
  for (const m of monthsList) {
    const rep = await buildMemberMonthlyReport(userId, m);
    username = rep.username;
    displayName = rep.displayName;
    // 年度页不聚合逐月警告（明细提示在月报查看，避免 12 个月叠加刷屏）
    months.push({
      month: m,
      rate: { usdToCny: rep.rate.usdToCny, date: rep.rate.date, locked: rep.rate.locked },
      adUsd: rep.adCostTotalUsd,
      adCny: rep.adCostTotalCny,
      profitAdCostUsd: rep.profitAdCostUsd,
      book: rep.totals.book,
      rejected: rep.totals.rejected,
      recvTotal: rep.totals.recvTotal,
      paidTotal: rep.totals.paidTotal,
      paidCnyTotal: rep.totals.paidCnyTotal,
      profitUsd: rep.profit.usd,
      profitCny: rep.profit.cny,
    });
  }

  const totals = {
    adUsd: r2(months.reduce((s, m) => s + m.adUsd, 0)),
    adCny: r2(months.reduce((s, m) => s + m.adCny, 0)),
    profitAdCostUsd: r2(months.reduce((s, m) => s + m.profitAdCostUsd, 0)),
    book: r2(months.reduce((s, m) => s + m.book, 0)),
    rejected: r2(months.reduce((s, m) => s + m.rejected, 0)),
    recvTotal: r2(months.reduce((s, m) => s + m.recvTotal, 0)),
    paidTotal: r2(months.reduce((s, m) => s + m.paidTotal, 0)),
    paidCnyTotal: r2(months.reduce((s, m) => s + m.paidCnyTotal, 0)),
    profitUsd: r2(months.reduce((s, m) => s + m.profitUsd, 0)),
    profitCny: r2(months.reduce((s, m) => s + m.profitCny, 0)),
  };

  return {
    year,
    userId: String(userId),
    username,
    displayName,
    generatedAt: nowCST().format("YYYY-MM-DD HH:mm:ss"),
    months,
    totals,
    warnings,
  };
}
