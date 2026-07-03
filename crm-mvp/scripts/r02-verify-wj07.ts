/**
 * R-02 验收（只读）：wj07 2026-06 报表核心口径 vs 7号机 Excel
 * 不依赖新表（report_overrides 等），可在迁移部署前跑。
 * 运行：npx tsx scripts/r02-verify-wj07.ts
 */
import "dotenv/config";
import prisma from "../src/lib/prisma";
import { sqlTxnRange, paymentDisplayAmount } from "../src/lib/report-metrics";

const MONTH = "2026-06";
const START = "2026-06-01";
const END = "2026-07-01";

// Excel 目标值（7号机6月收支统计.xlsx）
const EXPECT = {
  book: { LH: 216, RW: 44.86, MUI: 124.57, EV: 1890.41, PM: 16.69, total: 2292.53 },
  rejected: { LH: 15.22, RW: 4.29, MUI: 0, EV: 183.23, PM: 3.27, excelTotal: 190.79 },
  recvH1: { RW: 637.2 },
  recvH2: { LH: 76.12, RW: 118.75 },
  recvTotal: 832.07,
  adCost: 769.72,
  profit: 62.35,
};

async function main() {
  const user = await prisma.users.findFirst({
    where: { username: "wj07", is_deleted: 0 },
    select: { id: true, username: true },
  });
  if (!user) throw new Error("wj07 不存在");
  const userId = user.id;
  console.log(`用户 wj07 id=${userId}\n`);

  // ── 1. 账面/失效佣金 ──
  const txnRange = sqlTxnRange("t", START, END);
  const txnRows = await prisma.$queryRawUnsafe<{
    platform: string; account_name: string | null; book: number; rejected: number;
  }[]>(`
    SELECT t.platform, pc.account_name,
      SUM(CAST(t.commission_amount AS DECIMAL(14,4))) AS book,
      SUM(CASE WHEN t.status='rejected' THEN CAST(t.commission_amount AS DECIMAL(14,4)) ELSE 0 END) AS rejected
    FROM affiliate_transactions t
    LEFT JOIN platform_connections pc ON pc.id = t.platform_connection_id
    WHERE t.user_id = ? AND t.is_deleted = 0 AND ${txnRange.cond}
    GROUP BY t.platform, pc.account_name
    ORDER BY t.platform
  `, userId, ...txnRange.params);

  console.log("── 账面/失效佣金（按平台×账号） ──");
  let bookTotal = 0, rejTotal = 0;
  for (const r of txnRows) {
    bookTotal += Number(r.book); rejTotal += Number(r.rejected);
    const exp = EXPECT.book[r.platform as keyof typeof EXPECT.book];
    const expR = EXPECT.rejected[r.platform as keyof typeof EXPECT.rejected];
    console.log(`  ${r.platform}/${(r.account_name || "").trim()}: book=${Number(r.book).toFixed(2)} (Excel ${exp ?? "—"}) rejected=${Number(r.rejected).toFixed(2)} (Excel ${expR ?? "—"})`);
  }
  console.log(`  合计: book=${bookTotal.toFixed(2)} (Excel ${EXPECT.book.total}) rejected=${rejTotal.toFixed(2)} (Excel ${EXPECT.rejected.excelTotal}，注：Excel漏加LH 15.22)\n`);

  // ── 2. 应收/实收（request_date 半月桶，status=paid） ──
  const payments = await prisma.affiliate_payments.findMany({
    where: {
      user_id: userId, is_deleted: 0, status: "paid",
      request_date: { gte: new Date(`${START}T00:00:00Z`), lt: new Date(`${END}T00:00:00Z`) },
    },
    select: { platform: true, request_date: true, amount: true, gross_amount: true, status: true },
    orderBy: { request_date: "asc" },
  });
  console.log("── 打款记录（paid） ──");
  const buckets = new Map<string, { recvH1: number; recvH2: number; paidH1: number; paidH2: number }>();
  for (const p of payments) {
    const day = p.request_date!.getUTCDate();
    const recv = Number(p.amount || 0);
    const paid = paymentDisplayAmount(Number(p.amount || 0), p.gross_amount == null ? null : Number(p.gross_amount));
    const b = buckets.get(p.platform) || { recvH1: 0, recvH2: 0, paidH1: 0, paidH2: 0 };
    if (day <= 15) { b.recvH1 += recv; b.paidH1 += paid; } else { b.recvH2 += recv; b.paidH2 += paid; }
    buckets.set(p.platform, b);
    console.log(`  ${p.platform} ${p.request_date!.toISOString().slice(0, 10)} amount=${recv} gross=${p.gross_amount ?? "null"} → 半月=${day <= 15 ? "H1" : "H2"} 实收=${paid}`);
  }
  let recvTotal = 0;
  for (const [plat, b] of buckets) {
    recvTotal += b.recvH1 + b.recvH2;
    console.log(`  ${plat}: 应收H1=${b.recvH1.toFixed(2)} H2=${b.recvH2.toFixed(2)} | 实收H1=${b.paidH1.toFixed(2)} H2=${b.paidH2.toFixed(2)}`);
  }
  console.log(`  应收合计=${recvTotal.toFixed(2)} (Excel ${EXPECT.recvTotal})\n`);

  // ── 3. 广告费（MCC×月 + 补差额 + CNY反算） ──
  const costRows = await prisma.$queryRawUnsafe<{
    mcc_id: bigint | null; cost_usd: number; cost_cny: number;
  }[]>(`
    SELECT c.mcc_id,
      SUM(CAST(s.cost AS DECIMAL(16,6))) AS cost_usd,
      SUM(CASE WHEN e.rate_to_usd IS NOT NULL AND e.rate_to_usd > 0
           THEN CAST(s.cost AS DECIMAL(16,6)) / e.rate_to_usd ELSE 0 END) AS cost_cny
    FROM ads_daily_stats s
    JOIN campaigns c ON c.id = s.campaign_id
    LEFT JOIN exchange_rate_snapshots e ON e.currency='CNY' AND e.date = s.date
    WHERE s.user_id = ? AND s.is_deleted = 0 AND s.date >= ? AND s.date < ?
    GROUP BY c.mcc_id
  `, userId, new Date(`${START}T00:00:00Z`), new Date(`${END}T00:00:00Z`));

  const mccs = await prisma.google_mcc_accounts.findMany({
    where: { user_id: userId, is_deleted: 0 },
    select: { id: true, mcc_id: true, mcc_name: true, currency: true },
  });
  const adjustments = await prisma.mcc_cost_adjustments.findMany({
    where: { user_id: userId, month: MONTH, is_deleted: 0 },
  });
  console.log("── 广告费 ──");
  let adTotal = 0;
  for (const row of costRows) {
    const mcc = mccs.find((m) => String(m.id) === String(row.mcc_id));
    const adj = adjustments.filter((a) => String(a.mcc_account_id) === String(row.mcc_id)).reduce((s, a) => s + Number(a.amount), 0);
    const usd = Number(row.cost_usd || 0) + adj;
    adTotal += usd;
    console.log(`  MCC ${mcc?.mcc_name || row.mcc_id} (${mcc?.mcc_id || "?"}, ${mcc?.currency || "?"}): cost=${Number(row.cost_usd).toFixed(2)} adj=${adj} → ${usd.toFixed(2)}${mcc?.currency === "CNY" ? ` | CNY反算=${Number(row.cost_cny).toFixed(2)}` : ""}`);
  }
  console.log(`  合计=${adTotal.toFixed(2)} (Excel ${EXPECT.adCost})\n`);

  // ── 4. 汇率锁定（6月最后快照） ──
  const snap = await prisma.exchange_rate_snapshots.findFirst({
    where: { currency: "CNY", date: { lt: new Date(`${END}T00:00:00Z`) } },
    orderBy: { date: "desc" },
  });
  console.log(`── 汇率 ── ${snap ? `${snap.date.toISOString().slice(0, 10)} rate_to_usd=${snap.rate_to_usd} → 1USD=${(1 / Number(snap.rate_to_usd)).toFixed(4)}CNY` : "无快照"}\n`);

  // ── 5. 在投广告数 ──
  const enabled = await prisma.campaigns.count({ where: { user_id: userId, is_deleted: 0, google_status: "ENABLED" } });
  console.log(`── 在投广告数 ── ${enabled} (Excel 6，实时值会随时间变化)\n`);

  console.log(`── 可分配利润 ── ${(recvTotal - adTotal).toFixed(2)} (Excel ${EXPECT.profit})`);
}

main()
  .catch((e) => { console.error(e); process.exit(1); })
  .finally(() => prisma.$disconnect());
