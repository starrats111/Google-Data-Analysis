/**
 * 临时端点：验证 C-081 affiliate_transactions 写入闸门。
 * 用 cron token 调用，写一次性测试数据 → 校验规则 A/B → 清理 → 返回结果。
 * 完成验证后此文件会被删除。
 */
import { NextRequest, NextResponse } from "next/server";
import prisma from "@/lib/prisma";

function verifyCron(req: NextRequest): boolean {
  const secret = process.env.CRON_SECRET;
  if (!secret) return false;
  return req.headers.get("authorization") === `Bearer ${secret}`;
}

export async function GET(req: NextRequest) {
  if (!verifyCron(req)) {
    return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
  }

  const USER_ID = BigInt(1);
  const PLATFORM = "GTST";
  const TIME = new Date("2026-05-11T10:00:00Z");
  const results: Record<string, unknown> = {};

  try {
    await prisma.affiliate_transactions.deleteMany({
      where: { platform: PLATFORM, transaction_id: { startsWith: "GUARD_TEST_" } },
    });

    await prisma.affiliate_transactions.create({
      data: {
        user_id: USER_ID, user_merchant_id: BigInt(0), platform: PLATFORM,
        merchant_id: "GUARD_A", merchant_name: "test",
        transaction_id: "GUARD_TEST_A1", transaction_time: TIME,
        order_amount: 0, commission_amount: 0,
        currency: "USD", status: "pending", raw_status: "",
      },
    });
    const a1 = await prisma.affiliate_transactions.findFirst({
      where: { platform: PLATFORM, transaction_id: "GUARD_TEST_A1" },
      select: { commission_amount: true, order_amount: true, is_deleted: true },
    });
    results.rule_A_0_0_auto_deleted = {
      is_deleted: a1?.is_deleted,
      pass: a1?.is_deleted === 1,
    };

    await prisma.affiliate_transactions.create({
      data: {
        user_id: USER_ID, user_merchant_id: BigInt(0), platform: PLATFORM,
        merchant_id: "GUARD_B", merchant_name: "test",
        transaction_id: "GUARD_TEST_B1", transaction_time: TIME,
        order_amount: 100, commission_amount: 10,
        currency: "USD", status: "pending", raw_status: "",
      },
    });

    await prisma.affiliate_transactions.create({
      data: {
        user_id: USER_ID, user_merchant_id: BigInt(0), platform: PLATFORM,
        merchant_id: "GUARD_B", merchant_name: "test",
        transaction_id: "GUARD_TEST_B2", transaction_time: TIME,
        order_amount: 50, commission_amount: 5,
        currency: "USD", status: "pending", raw_status: "",
      },
    });

    const all = await prisma.affiliate_transactions.findMany({
      where: { platform: PLATFORM, transaction_id: { in: ["GUARD_TEST_B1", "GUARD_TEST_B2"] } },
      select: { transaction_id: true, commission_amount: true, order_amount: true, is_deleted: true },
      orderBy: { transaction_id: "asc" },
    });
    const b1 = all.find((r) => r.transaction_id === "GUARD_TEST_B1");
    const b2 = all.find((r) => r.transaction_id === "GUARD_TEST_B2");
    results.rule_B_line_items_merged = {
      b1_commission: b1 ? Number(b1.commission_amount) : null,
      b1_order_amount: b1 ? Number(b1.order_amount) : null,
      b2_exists: !!b2,
      pass: !!b1 && Number(b1.commission_amount) === 15 && Number(b1.order_amount) === 150 && !b2,
    };

    await prisma.affiliate_transactions.deleteMany({
      where: { platform: PLATFORM, transaction_id: { startsWith: "GUARD_TEST_" } },
    });

    return NextResponse.json({ ok: true, ...results });
  } catch (e) {
    return NextResponse.json({
      ok: false,
      error: e instanceof Error ? e.message : String(e),
      ...results,
    }, { status: 500 });
  }
}
