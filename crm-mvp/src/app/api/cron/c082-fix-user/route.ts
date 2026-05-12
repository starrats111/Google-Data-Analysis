import { NextRequest, NextResponse } from "next/server";
import dayjs from "dayjs";
import utc from "dayjs/plugin/utc";
import timezone from "dayjs/plugin/timezone";
import prisma from "@/lib/prisma";
import { normalizePlatformCode } from "@/lib/constants";
import { aggregateRawTransactions } from "@/lib/affiliate-txn-aggregate";
import { applyAffiliateCommissionToDailyStats } from "@/lib/daily-stats-commission";
import { recomputeMonthlySettlementForUser } from "@/lib/monthly-settlement-tracker";
import type { PlatformTransaction } from "@/lib/platform-api";

dayjs.extend(utc);
dayjs.extend(timezone);

const TZ = "Asia/Shanghai";

/**
 * POST /api/cron/c082-fix-user
 *
 * C-082 一次性运维端点：对指定用户做"修复 transaction_time"全流程。
 *
 * 背景：commit 1788f95f 错误地把 last_update_time（日级、会变）写入 affiliate_transactions.transaction_time
 * 字段，破坏了"transaction_time 是订单下单时间，唯一不变"的字段语义。
 *
 * 修复行为：
 *   1. 拉用户全部平台 API 数据（2025-01-01 → now）
 *   2. 用新代码逻辑（transaction_time = order_time）做 aggregateRawTransactions
 *   3. upsert 写入；update 路径会刷新 transaction_time → 修复已"漂移"的历史记录
 *   4. 孤儿清理：CRM 中是 is_deleted=0 但本次 API 拉取没命中的 (platform, transaction_id) 软删
 *      （这些是旧代码下的聚合代表行，新代码下不再是任何聚合组的代表，必为幽灵）
 *   5. applyAffiliateCommissionToDailyStats 全量重算 ads_daily_stats（最早 → now+1d）
 *   6. recomputeMonthlySettlementForUser 全量重算月度结算
 *
 * 鉴权：CRON_SECRET (Authorization: Bearer ...)
 * 参数：?user_id=N（必填）
 */

function verifyCron(req: NextRequest): boolean {
  const secret = process.env.CRON_SECRET;
  if (!secret) return false;
  return req.headers.get("authorization") === `Bearer ${secret}`;
}

function log(msg: string) {
  const ts = new Date().toISOString();
  console.error(`[CRON c082-fix-user ${ts}] ${msg}`);
}

export async function POST(req: NextRequest) {
  if (!verifyCron(req)) {
    return NextResponse.json({ ok: false, error: "Unauthorized" }, { status: 401 });
  }

  const userIdParam = req.nextUrl.searchParams.get("user_id");
  if (!userIdParam) {
    return NextResponse.json({ ok: false, error: "user_id required" }, { status: 400 });
  }
  const userId = BigInt(userIdParam);

  const startedAt = Date.now();
  const startStr = "2025-01-01";
  // C-084：CST 切日（推翻 C-080），与平台后台口径一致
  const endStr = dayjs().tz(TZ).format("YYYY-MM-DD");

  log(`begin user_id=${userId}, range=${startStr}..${endStr}`);

  const user = await prisma.users.findUnique({
    where: { id: userId },
    select: { id: true, username: true },
  });
  if (!user) {
    return NextResponse.json({ ok: false, error: "user not found" }, { status: 404 });
  }

  const connections = await prisma.platform_connections.findMany({
    where: { user_id: userId, is_deleted: 0, status: "connected" },
    select: { id: true, platform: true, account_name: true, api_key: true, channel_id: true },
  });
  const validConns = connections
    .filter((c) => {
      if (!c.api_key || c.api_key.length <= 5) return false;
      if (c.platform === "AD" && !(c.channel_id && c.channel_id.trim())) return false;
      return true;
    })
    .sort((a, b) => Number(b.id) - Number(a.id));

  // 预加载 user_merchants：用于 upsert 时填充 user_merchant_id（避免破坏前端按商家聚合的视图）
  const userMerchants = await prisma.user_merchants.findMany({
    where: { user_id: userId, is_deleted: 0 },
    select: { id: true, merchant_id: true, platform: true },
  });
  const merchantIdByKey = new Map<string, bigint>();
  for (const m of userMerchants) {
    merchantIdByKey.set(`${normalizePlatformCode(m.platform)}|${m.merchant_id}`, m.id);
  }

  const { fetchAllTransactions } = await import("@/lib/platform-api");

  const apiTxnKeySet = new Set<string>(); // `${platform}|${transaction_id}`
  const perPlatformStats: Record<string, { fetched: number; upserted: number; error?: string }> = {};

  for (const conn of validConns) {
    const platform = normalizePlatformCode(conn.platform);
    const label = conn.account_name || platform;
    const psKey = `${platform}/${label}`;
    perPlatformStats[psKey] = { fetched: 0, upserted: 0 };

    let raw: { transactions: PlatformTransaction[]; error?: string };
    try {
      raw = await fetchAllTransactions(platform, conn.api_key!, startStr, endStr);
    } catch (e) {
      perPlatformStats[psKey].error = e instanceof Error ? e.message : String(e);
      log(`  ${psKey} fetch error: ${perPlatformStats[psKey].error}`);
      continue;
    }
    if (raw.error && raw.transactions.length === 0) {
      perPlatformStats[psKey].error = raw.error;
      log(`  ${psKey} api error: ${raw.error}`);
      continue;
    }
    perPlatformStats[psKey].fetched = raw.transactions.length;

    const aggRes = aggregateRawTransactions(raw.transactions);
    const deduped = aggRes.aggregated;

    // 自动创建 missing user_merchants（API 返回但表中没有的）
    const missing = new Map<string, string>(); // mid → name
    for (const txn of deduped) {
      const mid = txn.merchant_id || "";
      if (!mid) continue;
      const key = `${platform}|${mid}`;
      if (!merchantIdByKey.has(key) && !missing.has(mid)) {
        missing.set(mid, txn.merchant || "");
      }
    }
    for (const [mid, name] of missing) {
      try {
        const excluded = await prisma.user_merchants.findFirst({
          where: { user_id: userId, platform, merchant_id: mid, status: "excluded" },
          select: { id: true },
        });
        if (excluded) continue;
        let existing = await prisma.user_merchants.findFirst({
          where: { user_id: userId, platform, merchant_id: mid, is_deleted: 0 },
          select: { id: true },
        });
        if (!existing) {
          existing = await prisma.user_merchants.create({
            data: { user_id: userId, platform, merchant_id: mid, merchant_name: name, status: "available" },
            select: { id: true },
          });
        }
        merchantIdByKey.set(`${platform}|${mid}`, existing.id);
      } catch { /* ignore race condition */ }
    }

    for (const txn of deduped) {
      const txnId = txn.transaction_id;
      if (!txnId) continue;
      apiTxnKeySet.add(`${platform}|${txnId}`);

      const mid = txn.merchant_id || "";
      const umId = (mid && merchantIdByKey.get(`${platform}|${mid}`)) || BigInt(0);

      try {
        await prisma.affiliate_transactions.upsert({
          where: { platform_transaction_id: { platform, transaction_id: txnId } },
          create: {
            user_id: userId, user_merchant_id: umId, platform_connection_id: conn.id,
            platform, merchant_id: mid, merchant_name: txn.merchant || "",
            transaction_id: txnId,
            transaction_time: new Date(txn.transaction_time),
            order_amount: txn.order_amount || 0,
            commission_amount: txn.commission_amount || 0,
            currency: "USD", status: txn.status, raw_status: txn.raw_status || "",
          },
          update: {
            merchant_id: mid,
            merchant_name: txn.merchant || undefined,
            ...(umId !== BigInt(0) ? { user_merchant_id: umId } : {}),
            transaction_time: new Date(txn.transaction_time),
            order_amount: txn.order_amount || 0,
            commission_amount: txn.commission_amount || 0,
            status: txn.status,
            raw_status: txn.raw_status || "",
            is_deleted: 0,
          },
        });
        perPlatformStats[psKey].upserted++;
      } catch (e) {
        log(`  ${psKey} upsert error tid=${txnId}: ${e instanceof Error ? e.message : String(e)}`);
      }
    }

    log(`  ${psKey}: fetched=${perPlatformStats[psKey].fetched}, deduped=${deduped.length}, upserted=${perPlatformStats[psKey].upserted}`);
  }

  // 孤儿清理：本次 sync 涉及的平台中，CRM 中 is_deleted=0 但不在 apiTxnKeySet 中的行 → 软删
  const platformsScanned = Array.from(new Set(validConns.map((c) => normalizePlatformCode(c.platform))));

  let orphansSoftDeleted = 0;
  if (platformsScanned.length > 0) {
    // 取所有候选行，逐一比对
    const crmRows = await prisma.affiliate_transactions.findMany({
      where: {
        user_id: userId,
        is_deleted: 0,
        platform: { in: platformsScanned },
        transaction_time: {
          gte: dayjs.utc(startStr).toDate(),
        },
      },
      select: { id: true, platform: true, transaction_id: true },
    });
    const toSoftDelete: bigint[] = [];
    for (const r of crmRows) {
      const k = `${r.platform}|${r.transaction_id}`;
      if (!apiTxnKeySet.has(k)) toSoftDelete.push(r.id);
    }
    log(`  candidate=${crmRows.length}, orphan=${toSoftDelete.length}`);

    for (let i = 0; i < toSoftDelete.length; i += 500) {
      const batch = toSoftDelete.slice(i, i + 500);
      const res = await prisma.affiliate_transactions.updateMany({
        where: { id: { in: batch } },
        data: { is_deleted: 1 },
      });
      orphansSoftDeleted += res.count;
    }
  }

  // 重算 ads_daily_stats / monthly_settlement_status
  const earliest = await prisma.affiliate_transactions.findFirst({
    where: { user_id: userId, is_deleted: 0 },
    orderBy: { transaction_time: "asc" },
    select: { transaction_time: true },
  });

  let commissionRowsUpdated = 0;
  let monthsUpdated = 0;
  let recomputeRangeStart: string | null = null;
  let recomputeRangeEnd: string | null = null;
  if (earliest?.transaction_time) {
    // C-084：CST 切日，与平台后台口径一致
    const rangeStart = dayjs(earliest.transaction_time).tz(TZ).startOf("month").toDate();
    const rangeEnd = dayjs().tz(TZ).startOf("day").add(1, "day").toDate();
    recomputeRangeStart = rangeStart.toISOString();
    recomputeRangeEnd = rangeEnd.toISOString();
    commissionRowsUpdated = await applyAffiliateCommissionToDailyStats(userId, rangeStart, rangeEnd);
    monthsUpdated = await recomputeMonthlySettlementForUser(userId);
  }

  const elapsedSec = ((Date.now() - startedAt) / 1000).toFixed(1);
  log(`DONE user=${user.username} platforms=${platformsScanned.join(",")} orphans=${orphansSoftDeleted} commission_rows=${commissionRowsUpdated} months=${monthsUpdated} elapsed=${elapsedSec}s`);

  return NextResponse.json({
    ok: true,
    user: user.username,
    user_id: String(userId),
    elapsed_s: parseFloat(elapsedSec),
    platforms_scanned: platformsScanned,
    per_platform: perPlatformStats,
    orphans_soft_deleted: orphansSoftDeleted,
    commission_rows_updated: commissionRowsUpdated,
    months_updated: monthsUpdated,
    recompute_range_start: recomputeRangeStart,
    recompute_range_end: recomputeRangeEnd,
  });
}
