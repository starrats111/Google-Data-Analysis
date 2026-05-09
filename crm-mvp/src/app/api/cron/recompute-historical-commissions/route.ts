import { NextRequest, NextResponse } from "next/server";
import dayjs from "dayjs";
import utc from "dayjs/plugin/utc";
import timezone from "dayjs/plugin/timezone";
import prisma from "@/lib/prisma";
import { applyAffiliateCommissionToDailyStats } from "@/lib/daily-stats-commission";
import { recomputeMonthlySettlementForUser } from "@/lib/monthly-settlement-tracker";

dayjs.extend(utc);
dayjs.extend(timezone);

const TZ = "Asia/Shanghai";

/**
 * GET /api/cron/recompute-historical-commissions
 *
 * C-074 配套运维端点：对所有用户全部历史月份重算 ads_daily_stats.commission。
 *
 * 背景：C-074 把 affiliate_transactions 的查询/分桶视角从 UTC 切到 CST。
 * txn-quick-sync 自动覆盖了"近 14 天"，但更早的月份（2025-09 ~ 2026-04）
 * 仍按旧的 UTC 视角分桶在 ads_daily_stats，跨日订单挂错日期需要全量重算。
 *
 * 行为：
 *   1. 列出所有非删除用户
 *   2. 对每个用户：
 *      a. 找最早 affiliate_transactions 的月初（CST 月初）
 *      b. 调 applyAffiliateCommissionToDailyStats(userId, earliest, now+1d)
 *         （内部会先 updateMany 清零区间，再按 CST 视角重新写入）
 *      c. 调 recomputeMonthlySettlementForUser 重算月度结算状态
 *   3. 不调用任何外部联盟 API，纯本地数据库操作
 *
 * 鉴权：CRON_SECRET (Authorization: Bearer ...)
 *
 * 查询参数：
 *   - user_id（可选）：仅对指定用户重算，不传则全量
 *
 * 该端点幂等，可重复调用。
 */

function verifyCron(req: NextRequest): boolean {
  const secret = process.env.CRON_SECRET;
  if (!secret) return false;
  return req.headers.get("authorization") === `Bearer ${secret}`;
}

function log(msg: string) {
  const ts = new Date().toISOString();
  console.error(`[CRON recompute-historical ${ts}] ${msg}`);
}

export async function GET(req: NextRequest) {
  if (!verifyCron(req)) {
    return NextResponse.json({ ok: false, error: "Unauthorized" }, { status: 401 });
  }

  const userIdParam = req.nextUrl.searchParams.get("user_id");

  const startTime = Date.now();
  log("开始全量重算历史佣金（C-074 配套）...");

  const where: { is_deleted: number; id?: bigint } = { is_deleted: 0 };
  if (userIdParam) where.id = BigInt(userIdParam);

  const users = await prisma.users.findMany({
    where,
    select: { id: true, username: true },
    orderBy: { id: "asc" },
  });

  log(`目标用户数：${users.length}`);

  const results: Record<string, unknown> = {};
  let totalRowsUpdated = 0;
  let totalMonthsUpdated = 0;
  let totalUsersWithData = 0;

  for (const user of users) {
    const userId = user.id;
    const userStart = Date.now();
    try {
      const earliest = await prisma.affiliate_transactions.findFirst({
        where: { user_id: userId, is_deleted: 0 },
        orderBy: { transaction_time: "asc" },
        select: { transaction_time: true },
      });

      if (!earliest?.transaction_time) {
        results[user.username] = { skipped: "no transactions" };
        continue;
      }

      // CST 视角：从最早交易所在月的 CST 月初，到 CST 明天 0 点
      const earliestUtc = dayjs(earliest.transaction_time).tz(TZ).startOf("month").toDate();
      const endExclusive = dayjs().tz(TZ).startOf("day").add(1, "day").toDate();

      const rowsUpdated = await applyAffiliateCommissionToDailyStats(userId, earliestUtc, endExclusive);
      const monthsUpdated = await recomputeMonthlySettlementForUser(userId);

      const elapsed = ((Date.now() - userStart) / 1000).toFixed(1);
      totalRowsUpdated += rowsUpdated;
      totalMonthsUpdated += monthsUpdated;
      totalUsersWithData++;

      log(`  ${user.username}: ${rowsUpdated} stats rows, ${monthsUpdated} months, ${elapsed}s`);
      results[user.username] = {
        commission_rows_updated: rowsUpdated,
        months_updated: monthsUpdated,
        elapsed_s: parseFloat(elapsed),
        range_start: earliestUtc.toISOString(),
        range_end: endExclusive.toISOString(),
      };
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      log(`  ${user.username} fatal: ${msg}`);
      results[user.username] = { error: msg };
    }
  }

  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
  log(`全量重算完成：${totalUsersWithData}/${users.length} 用户处理，更新 ${totalRowsUpdated} 行佣金，${totalMonthsUpdated} 个月份，耗时 ${elapsed}s`);

  return NextResponse.json({
    ok: true,
    elapsed_s: parseFloat(elapsed),
    users_processed: totalUsersWithData,
    users_total: users.length,
    commission_rows_updated_total: totalRowsUpdated,
    months_updated_total: totalMonthsUpdated,
    results,
  });
}
