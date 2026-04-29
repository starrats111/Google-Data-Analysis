import { NextRequest, NextResponse } from "next/server";
import prisma from "@/lib/prisma";
import { normalizePlatformCode } from "@/lib/constants";
import { nowCST } from "@/lib/date-utils";
import { getRedirectedMerchantKeys } from "@/lib/merchant-ownership-rules";

const CRON_SECRET = process.env.CRON_SECRET || "";
/** 快速同步的时间窗口（天）：覆盖所有状态活跃中的订单 */
const QUICK_SYNC_DAYS = 14;

function verifyCron(req: NextRequest): boolean {
  if (!CRON_SECRET) return false;
  const auth = req.headers.get("authorization");
  return auth === `Bearer ${CRON_SECRET}`;
}

function log(msg: string) {
  const ts = new Date().toISOString();
  console.error(`[CRON txn-quick-sync ${ts}] ${msg}`);
}

/**
 * 将用户交易版本戳写入 system_configs，供前端轮询感知变化。
 * key 格式：txn_version_{userId}
 */
async function updateTxnVersion(userId: bigint, ts: string): Promise<void> {
  const key = `txn_version_${userId}`;
  await prisma.system_configs.upsert({
    where: { config_key: key },
    create: { config_key: key, config_value: ts, description: `交易数据版本戳 (user ${userId})`, is_deleted: 0 },
    update: { config_value: ts, is_deleted: 0 },
  });
}

/**
 * 获取用户当前 affiliate_transactions 的最新 updated_at（用于变更检测）
 */
async function getMaxUpdatedAt(userId: bigint): Promise<string> {
  const row = await prisma.affiliate_transactions.findFirst({
    where: { user_id: userId, is_deleted: 0 },
    orderBy: { updated_at: "desc" },
    select: { updated_at: true },
  });
  return row?.updated_at?.toISOString() ?? "1970-01-01T00:00:00.000Z";
}

/**
 * GET /api/cron/txn-quick-sync
 *
 * 每 10 分钟执行：快速同步全部用户过去 14 天的交易数据。
 * 有变动时更新 system_configs 中的版本戳，前端通过轮询感知并局部刷新。
 * 失败时静默跳过，不影响现有 daily-sync。
 */
export const dynamic = "force-dynamic";
export const maxDuration = 300;

export async function GET(req: NextRequest) {
  if (!verifyCron(req)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const startTime = Date.now();
  log("开始快速交易同步...");

  const users = await prisma.users.findMany({
    where: { is_deleted: 0, status: "active", role: { in: ["user", "leader"] } },
    select: { id: true, username: true },
  });

  const cstNow = nowCST();
  const startStr = cstNow.subtract(QUICK_SYNC_DAYS, "day").format("YYYY-MM-DD");
  const endStr = cstNow.format("YYYY-MM-DD");

  const results: Record<string, unknown> = {};
  let totalChanged = 0;

  for (const user of users) {
    const userId = user.id;
    try {
      const conns = await prisma.platform_connections.findMany({
        where: { user_id: userId, is_deleted: 0, status: "connected" },
        select: { id: true, platform: true, account_name: true, api_key: true },
      });
      const validConns = conns
        .filter((c) => c.api_key && c.api_key.length > 5)
        .sort((a, b) => Number(b.id) - Number(a.id));

      if (validConns.length === 0) {
        results[user.username] = { skipped: true };
        continue;
      }

      // 变更检测：记录同步前的最新 updated_at
      const beforeTs = await getMaxUpdatedAt(userId);

      const { fetchAllTransactions } = await import("@/lib/platform-api");
      const userMerchants = await prisma.user_merchants.findMany({
        where: { user_id: userId, is_deleted: 0 },
        select: { id: true, merchant_id: true, platform: true, merchant_name: true },
      });
      const merchantMap = new Map(
        userMerchants.map((m) => [`${normalizePlatformCode(m.platform)}_${m.merchant_id}`, m])
      );
      const redirectRules = getRedirectedMerchantKeys(userId);

      let upserted = 0;
      const platformStats: Record<string, number> = {};

      for (const conn of validConns) {
        const platform = normalizePlatformCode(conn.platform);
        try {
          const r = await fetchAllTransactions(platform, conn.api_key!, startStr, endStr);
          if (r.error && r.transactions.length === 0) continue;
          if (!r.transactions.length) continue;

          for (const txn of r.transactions) {
            if (!txn.transaction_id) continue;
            const mid = txn.merchant_id || "";
            const merchantKey = `${platform}_${mid}`;

            // 归属重定向规则
            const rule = redirectRules.get(merchantKey);
            if (rule) {
              await prisma.affiliate_transactions.upsert({
                where: { platform_transaction_id: { platform, transaction_id: txn.transaction_id } },
                create: {
                  user_id: BigInt(rule.target_user_id),
                  user_merchant_id: BigInt(rule.target_user_merchant_id),
                  campaign_id: BigInt(rule.target_campaign_id),
                  platform_connection_id: conn.id,
                  platform, merchant_id: mid, merchant_name: txn.merchant || "",
                  transaction_id: txn.transaction_id,
                  transaction_time: new Date(txn.transaction_time),
                  order_amount: txn.order_amount || 0,
                  commission_amount: txn.commission_amount || 0,
                  currency: "USD", status: txn.status, raw_status: txn.raw_status || "",
                },
                update: {
                  commission_amount: txn.commission_amount || 0,
                  status: txn.status, raw_status: txn.raw_status || "",
                  order_amount: txn.order_amount || 0,
                  merchant_name: txn.merchant || undefined,
                  is_deleted: 0,
                },
              });
              upserted++;
              continue;
            }

            const merchant = merchantMap.get(merchantKey);
            const umId = merchant ? merchant.id : BigInt(0);
            const merchantName = txn.merchant || merchant?.merchant_name || "";

            await prisma.affiliate_transactions.upsert({
              where: { platform_transaction_id: { platform, transaction_id: txn.transaction_id } },
              create: {
                user_id: userId, user_merchant_id: umId,
                platform_connection_id: conn.id,
                platform, merchant_id: mid, merchant_name: merchantName,
                transaction_id: txn.transaction_id,
                transaction_time: new Date(txn.transaction_time),
                order_amount: txn.order_amount || 0,
                commission_amount: txn.commission_amount || 0,
                currency: "USD", status: txn.status, raw_status: txn.raw_status || "",
              },
              update: {
                merchant_name: merchantName || undefined,
                order_amount: txn.order_amount || 0,
                commission_amount: txn.commission_amount || 0,
                status: txn.status, raw_status: txn.raw_status || "",
                is_deleted: 0,
                ...(umId !== BigInt(0) ? { user_merchant_id: umId } : {}),
              },
            });
            upserted++;
          }

          platformStats[platform] = (platformStats[platform] || 0) + r.transactions.length;
        } catch (e) {
          log(`  ${user.username} ${conn.account_name || platform} error: ${e instanceof Error ? e.message : String(e)}`);
        }
      }

      // 变更检测：同步后再取一次 updated_at，有变化则更新版本戳
      const afterTs = await getMaxUpdatedAt(userId);
      const hasChange = afterTs !== beforeTs;
      if (hasChange) {
        await updateTxnVersion(userId, afterTs);
        totalChanged++;
        log(`  ${user.username}: changed ✓ (${upserted} upserted)`);
      } else {
        log(`  ${user.username}: no change (${upserted} upserted)`);
      }

      results[user.username] = { upserted, changed: hasChange, platforms: platformStats };
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      log(`  ${user.username} fatal: ${msg}`);
      results[user.username] = { error: msg };
    }
  }

  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
  log(`快速同步完成：${totalChanged}/${users.length} 用户有变动，耗时 ${elapsed}s`);

  return NextResponse.json({
    ok: true,
    elapsed_s: parseFloat(elapsed),
    users_changed: totalChanged,
    users_total: users.length,
    window_days: QUICK_SYNC_DAYS,
    results,
  });
}
