/**
 * PB 历史支付回填（一次性）：对所有 PB 连接调 payment_summary，范围 2025-01-01 ~ 今天。
 * 入库逻辑照搬官方 syncPaymentsForUsers（upsert affiliate_payments，主连接归并）。
 *   set -a; source .env; set +a
 *   npx tsx scripts/_backfill_pb_payments.ts
 */
import prisma from "../src/lib/prisma";
import { normalizePlatformCode } from "../src/lib/constants";
import { nowCST } from "../src/lib/date-utils";

async function main() {
  const { fetchPlatformPayments } = await import("../src/lib/payment-api");
  const { resolveMainConnectionMap } = await import("../src/lib/payment-main-connection");
  const startStr = "2025-01-01";
  const endStr = nowCST().format("YYYY-MM-DD");
  console.log(`# PB 支付回填 ${startStr} ~ ${endStr}`);

  const conns = await prisma.platform_connections.findMany({
    where: { platform: "PB", is_deleted: 0, status: "connected" },
    select: { id: true, user_id: true, platform: true, account_name: true, api_key: true, created_at: true },
  });
  const mainConnMap = await resolveMainConnectionMap(conns);
  const seen = new Set<string>();
  let total = 0;
  for (const conn of conns) {
    if (!conn.api_key || conn.api_key.length <= 5) continue;
    const k = `PB::${conn.api_key}`;
    if (seen.has(k)) continue;
    seen.add(k);
    const platform = normalizePlatformCode(conn.platform);
    try {
      const { payments, error } = await fetchPlatformPayments(platform, conn.api_key, startStr, endStr);
      if (error) { console.log(`  conn=${conn.id} uid=${conn.user_id} 错误: ${error}`); continue; }
      const mainConnId = mainConnMap.get(String(conn.id)) ?? conn.id;
      for (const p of payments) {
        await prisma.affiliate_payments.upsert({
          where: { platform_platform_connection_id_payment_no: { platform, platform_connection_id: mainConnId, payment_no: p.payment_no } },
          create: { user_id: conn.user_id, platform, platform_connection_id: mainConnId, payment_no: p.payment_no, source_kind: p.source_kind, paid_date: p.paid_date ? new Date(p.paid_date) : null, request_date: p.request_date ? new Date(p.request_date) : null, amount: p.amount, gross_amount: p.gross_amount ?? null, currency: p.currency, status: p.status, raw_status: p.raw_status || null, payment_type: p.payment_type ?? null, raw_json: p.raw_json || null },
          update: { source_kind: p.source_kind, paid_date: p.paid_date ? new Date(p.paid_date) : null, request_date: p.request_date ? new Date(p.request_date) : null, amount: p.amount, gross_amount: p.gross_amount ?? null, status: p.status, raw_status: p.raw_status || null, payment_type: p.payment_type ?? null, raw_json: p.raw_json || null, is_deleted: 0 },
        });
      }
      total += payments.length;
      console.log(`  conn=${conn.id} uid=${conn.user_id} 支付=${payments.length} 条`);
    } catch (e) {
      console.error(`  conn=${conn.id} err: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  console.log(`\n## 合计 upsert ${total} 条 PB 支付记录`);
  await prisma.$disconnect();
}
main().catch((e) => { console.error(e); process.exit(1); });
