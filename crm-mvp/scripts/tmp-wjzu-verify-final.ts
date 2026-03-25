/**
 * 模拟 wjzu（leader）在结算查询页看到的团队佣金汇总
 */
import "dotenv/config";
import prisma from "../src/lib/prisma";
import { TZ, parseCSTDateStart } from "../src/lib/date-utils";

const RANGE_START = "2025-11-01";
const RANGE_END_EXCLUSIVE = "2026-03-01";
const TARGET_MONTHS = ["2025-11", "2025-12", "2026-01", "2026-02"] as const;
const fix2 = (n: number) => +n.toFixed(2);

async function main() {
  const wjzu = await prisma.users.findFirst({ where: { username: "wjzu", is_deleted: 0 }, select: { id: true, role: true, team_id: true } });
  if (!wjzu?.team_id) throw new Error("未找到 wjzu");

  const teamMembers = await prisma.users.findMany({
    where: { team_id: wjzu.team_id, is_deleted: 0, role: { not: "admin" } },
    select: { id: true, username: true, display_name: true },
  });
  const memberIds = teamMembers.map((m) => m.id);
  const memberNameMap = new Map(teamMembers.map((m) => [m.id.toString(), m.display_name || m.username]));

  const txns = await prisma.affiliate_transactions.findMany({
    where: { user_id: { in: memberIds }, is_deleted: 0, transaction_time: { gte: parseCSTDateStart(RANGE_START), lt: parseCSTDateStart(RANGE_END_EXCLUSIVE) } },
    select: { user_id: true, transaction_time: true, commission_amount: true, status: true },
    orderBy: { transaction_time: "desc" },
    take: 100000,
  });

  console.log(`[DB] 查询到 ${txns.length} 条交易记录`);

  // 按月聚合
  const monthlyMap = new Map<string, { total: number; approved: number; rejected: number; paid: number; pending: number; orders: number }>();
  // 按员工聚合
  const memberMap = new Map<string, { username: string; total: number; approved: number; rejected: number; paid: number; pending: number; orders: number }>();

  for (const t of txns) {
    const amt = Number(t.commission_amount || 0);
    const monthKey = new Date(t.transaction_time).toLocaleDateString("sv-SE", { timeZone: TZ, year: "numeric", month: "2-digit" }).slice(0, 7);

    // 按月
    const me = monthlyMap.get(monthKey) || { total: 0, approved: 0, rejected: 0, paid: 0, pending: 0, orders: 0 };
    me.total += amt; me.orders += 1;
    if (t.status === "approved") me.approved += amt;
    else if (t.status === "rejected") me.rejected += amt;
    else if (t.status === "paid") me.paid += amt;
    else me.pending += amt;
    monthlyMap.set(monthKey, me);

    // 按员工
    const uid = t.user_id.toString();
    const ee = memberMap.get(uid) || { username: memberNameMap.get(uid) || uid, total: 0, approved: 0, rejected: 0, paid: 0, pending: 0, orders: 0 };
    ee.total += amt; ee.orders += 1;
    if (t.status === "approved") ee.approved += amt;
    else if (t.status === "rejected") ee.rejected += amt;
    else if (t.status === "paid") ee.paid += amt;
    else ee.pending += amt;
    memberMap.set(uid, ee);
  }

  const monthly = TARGET_MONTHS.map((m) => {
    const d = monthlyMap.get(m) || { total: 0, approved: 0, rejected: 0, paid: 0, pending: 0, orders: 0 };
    return { month: m, total: fix2(d.total), approved: fix2(d.approved), rejected: fix2(d.rejected), paid: fix2(d.paid), pending: fix2(d.pending), orders: d.orders };
  });

  const members = [...memberMap.values()].sort((a, b) => b.total - a.total).map((m) => ({
    ...m, total: fix2(m.total), approved: fix2(m.approved), rejected: fix2(m.rejected), paid: fix2(m.paid), pending: fix2(m.pending),
  }));

  // 总计
  const totals = { total: 0, approved: 0, rejected: 0, paid: 0, pending: 0, orders: 0 };
  for (const m of monthly) { totals.total += m.total; totals.approved += m.approved; totals.rejected += m.rejected; totals.paid += m.paid; totals.pending += m.pending; totals.orders += m.orders; }

  console.log(JSON.stringify({
    team_members: teamMembers.map((m) => m.username).join(", "),
    total_txns: txns.length,
    summary: { total: fix2(totals.total), approved: fix2(totals.approved), rejected: fix2(totals.rejected), paid: fix2(totals.paid), pending: fix2(totals.pending), orders: totals.orders },
    monthly,
    members,
  }, null, 2));
}

main().catch((e) => { console.error(e); process.exitCode = 1; }).finally(() => prisma["$disconnect"]());
