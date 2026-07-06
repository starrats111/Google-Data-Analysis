import { NextRequest } from "next/server";
import { apiSuccess, apiError } from "@/lib/constants";
import { withLeader } from "@/lib/api-handler";
import prisma from "@/lib/prisma";

export const dynamic = "force-dynamic";

/**
 * R-07 银行流水 — 平台总打款入账登记（组长）
 *
 * GET    ?month=YYYY-MM             本月全部流水条目 + 本组收款方式（含期初余额）
 * POST   { month, paymentMethodId, platform, txnAt, amount, ... }  新增打款登记
 * PUT    { id, ...可改字段 }         修改（含员工明细 breakdown，改后手续费自动重算）
 * DELETE { id }                     软删
 *
 * 手续费口径：fee = 员工明细合计(expected_amount) − 实际入账(amount)。
 * 员工明细默认由前端按「该收款方式×该平台×该半月」的组员实收(CNY)生效值预填，可修改。
 */

export interface BankFlowBreakdownItem {
  userId: string;
  username: string;
  displayName: string;
  platform: string;
  account: string;
  amount: number;
}

const r2 = (n: number) => Math.round(n * 100) / 100;

function parseBreakdown(raw: unknown): { items: BankFlowBreakdownItem[]; total: number } | null {
  if (!Array.isArray(raw)) return null;
  if (raw.length > 200) return null;
  const items: BankFlowBreakdownItem[] = [];
  let total = 0;
  for (const it of raw) {
    if (!it || typeof it !== "object") return null;
    const o = it as Record<string, unknown>;
    const amount = Number(o.amount);
    if (!isFinite(amount) || Math.abs(amount) > 999999999) return null;
    items.push({
      userId: String(o.userId ?? ""),
      username: String(o.username ?? "").slice(0, 32),
      displayName: String(o.displayName ?? "").slice(0, 32),
      platform: String(o.platform ?? "").slice(0, 8),
      account: String(o.account ?? "").slice(0, 64),
      amount: r2(amount),
    });
    total += amount;
  }
  return { items, total: r2(total) };
}

function serializeEntry(e: {
  id: bigint; team_id: bigint; month: string; payment_method_id: bigint; txn_at: Date;
  platform: string; counterparty: string; summary: string;
  amount: unknown; currency: string; expected_amount: unknown; fee: unknown;
  breakdown: string | null; remark: string | null; created_at: Date; updated_at: Date;
}) {
  let breakdown: BankFlowBreakdownItem[] = [];
  try {
    breakdown = e.breakdown ? JSON.parse(e.breakdown) : [];
  } catch { /* 脏数据容错：明细置空 */ }
  return {
    id: String(e.id),
    month: e.month,
    paymentMethodId: String(e.payment_method_id),
    txnAt: e.txn_at.toISOString(),
    platform: e.platform,
    counterparty: e.counterparty,
    summary: e.summary,
    amount: Number(e.amount),
    currency: e.currency,
    expectedAmount: Number(e.expected_amount),
    fee: Number(e.fee),
    breakdown,
    remark: e.remark || "",
    updatedAt: e.updated_at.toISOString(),
  };
}

// ── GET：月度流水 + 收款方式清单（含期初余额） ──────────────────────────────
export const GET = withLeader(async (req: NextRequest, { user }) => {
  if (!user.teamId) return apiError("未关联小组");
  const teamId = BigInt(user.teamId);
  const month = new URL(req.url).searchParams.get("month") || "";
  if (!/^\d{4}-\d{2}$/.test(month)) return apiError("month 格式必须为 YYYY-MM");

  const [methods, entries, openings] = await Promise.all([
    prisma.payment_methods.findMany({
      where: { team_id: teamId, is_deleted: 0 },
      orderBy: { created_at: "asc" },
      select: { id: true, payee_name: true, card_no: true },
    }),
    prisma.bank_flow_entries.findMany({
      where: { team_id: teamId, month, is_deleted: 0 },
      orderBy: { txn_at: "asc" },
    }),
    prisma.report_overrides.findMany({
      where: { user_id: BigInt(user.userId), month, scope_key: { startsWith: "bank_open:" }, is_deleted: 0 },
      select: { scope_key: true, value: true },
    }),
  ]);

  const openMap = new Map(openings.map((o) => [o.scope_key.slice("bank_open:".length), Number(o.value)]));
  return apiSuccess({
    methods: methods.map((m) => ({
      id: String(m.id),
      payeeName: m.payee_name,
      cardNo: m.card_no,
      openingBalance: openMap.get(String(m.id)) ?? null,
    })),
    entries: entries.map(serializeEntry),
  });
});

// ── POST：新增打款登记 / 保存期初余额 ────────────────────────────────────────
export const POST = withLeader(async (req: NextRequest, { user }) => {
  if (!user.teamId) return apiError("未关联小组");
  const teamId = BigInt(user.teamId);
  const body = await req.json();

  // 期初余额（导出流水单滚动余额用）：{ kind:"opening", month, paymentMethodId, value|null }
  if (body.kind === "opening") {
    const { month, paymentMethodId, value } = body;
    if (!/^\d{4}-\d{2}$/.test(month || "")) return apiError("month 格式必须为 YYYY-MM");
    if (!paymentMethodId) return apiError("缺少收款方式");
    const scopeKey = `bank_open:${paymentMethodId}`;
    const leaderId = BigInt(user.userId);
    if (value === null) {
      await prisma.report_overrides.updateMany({
        where: { user_id: leaderId, month, scope_key: scopeKey, is_deleted: 0 },
        data: { is_deleted: 1 },
      });
      return apiSuccess(null, "已清除期初余额");
    }
    const num = Number(value);
    if (!isFinite(num) || Math.abs(num) > 999999999) return apiError("期初余额必须为数字");
    await prisma.report_overrides.upsert({
      where: { user_id_month_scope_key: { user_id: leaderId, month, scope_key: scopeKey } },
      update: { value: num, updated_by: leaderId, is_deleted: 0 },
      create: { user_id: leaderId, month, scope_key: scopeKey, value: num, updated_by: leaderId },
    });
    return apiSuccess(null, "期初余额已保存");
  }

  const { month, paymentMethodId, platform, txnAt, amount, currency, counterparty, summary, remark, breakdown } = body;
  if (!/^\d{4}-\d{2}$/.test(month || "")) return apiError("month 格式必须为 YYYY-MM");
  if (typeof platform !== "string" || !/^[A-Z]{2,8}$/.test(platform)) return apiError("platform 无效");
  const txnDate = new Date(txnAt);
  if (isNaN(txnDate.getTime())) return apiError("到账时间无效");
  const amt = Number(amount);
  if (!isFinite(amt) || amt < 0 || amt > 999999999) return apiError("总打款金额必须为非负数字");

  const method = await prisma.payment_methods.findFirst({
    where: { id: BigInt(paymentMethodId || 0), team_id: teamId, is_deleted: 0 },
    select: { id: true },
  });
  if (!method) return apiError("收款方式不存在");

  const bd = parseBreakdown(breakdown ?? []);
  if (!bd) return apiError("员工明细格式无效");

  const created = await prisma.bank_flow_entries.create({
    data: {
      team_id: teamId,
      month,
      payment_method_id: method.id,
      txn_at: txnDate,
      platform,
      counterparty: typeof counterparty === "string" ? counterparty.trim().slice(0, 128) : "",
      summary: typeof summary === "string" && summary.trim() ? summary.trim().slice(0, 128) : "佣金结算",
      amount: amt,
      currency: typeof currency === "string" && currency ? currency.slice(0, 8) : "CNY",
      expected_amount: bd.total,
      fee: r2(bd.total - amt),
      breakdown: JSON.stringify(bd.items),
      remark: typeof remark === "string" ? remark.slice(0, 255) : null,
      created_by: BigInt(user.userId),
    },
  });
  return apiSuccess(serializeEntry(created), "已登记");
});

// ── PUT：修改（重算手续费） ──────────────────────────────────────────────────
export const PUT = withLeader(async (req: NextRequest, { user }) => {
  if (!user.teamId) return apiError("未关联小组");
  const teamId = BigInt(user.teamId);
  const body = await req.json();
  const { id } = body;
  if (!id) return apiError("缺少 ID");

  const existing = await prisma.bank_flow_entries.findFirst({
    where: { id: BigInt(id), team_id: teamId, is_deleted: 0 },
  });
  if (!existing) return apiError("流水记录不存在");

  const data: Record<string, unknown> = {};
  if (body.txnAt !== undefined) {
    const d = new Date(body.txnAt);
    if (isNaN(d.getTime())) return apiError("到账时间无效");
    data.txn_at = d;
  }
  if (body.platform !== undefined) {
    if (typeof body.platform !== "string" || !/^[A-Z]{2,8}$/.test(body.platform)) return apiError("platform 无效");
    data.platform = body.platform;
  }
  if (body.counterparty !== undefined) data.counterparty = String(body.counterparty).trim().slice(0, 128);
  if (body.summary !== undefined) data.summary = String(body.summary).trim().slice(0, 128) || "佣金结算";
  if (body.remark !== undefined) data.remark = String(body.remark).slice(0, 255);

  let amt = Number(existing.amount);
  if (body.amount !== undefined) {
    amt = Number(body.amount);
    if (!isFinite(amt) || amt < 0 || amt > 999999999) return apiError("总打款金额必须为非负数字");
    data.amount = amt;
  }
  let expected = Number(existing.expected_amount);
  if (body.breakdown !== undefined) {
    const bd = parseBreakdown(body.breakdown);
    if (!bd) return apiError("员工明细格式无效");
    expected = bd.total;
    data.breakdown = JSON.stringify(bd.items);
    data.expected_amount = expected;
  }
  data.fee = r2(expected - amt);

  const updated = await prisma.bank_flow_entries.update({ where: { id: existing.id }, data });
  return apiSuccess(serializeEntry(updated), "已保存");
});

// ── DELETE：软删 ─────────────────────────────────────────────────────────────
export const DELETE = withLeader(async (req: NextRequest, { user }) => {
  if (!user.teamId) return apiError("未关联小组");
  const teamId = BigInt(user.teamId);
  const { id } = await req.json();
  if (!id) return apiError("缺少 ID");

  const existing = await prisma.bank_flow_entries.findFirst({
    where: { id: BigInt(id), team_id: teamId, is_deleted: 0 },
    select: { id: true },
  });
  if (!existing) return apiError("流水记录不存在");

  await prisma.bank_flow_entries.update({ where: { id: existing.id }, data: { is_deleted: 1 } });
  return apiSuccess(null, "已删除");
});
