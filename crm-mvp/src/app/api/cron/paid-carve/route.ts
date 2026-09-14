import { NextRequest, NextResponse } from "next/server";
import prisma from "@/lib/prisma";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

/**
 * D-333 RW/LH/LB 已付剖分独立 cron（从 daily-sync Step 3.6 摘出）
 *
 * 触发：每日 09:40 CST（crontab `40 9 * * *`），排在 daily-sync(06:00) 之后、
 *       且刻意避开交易同步 07:51 前后的 OOM 窗口。
 *
 * 为什么必须独立成一条 cron：
 *   剖分原先是 daily-sync 的 Step 3.6，紧跟 Step 3（交易同步）。而 Step 3 每天把
 *   Node 堆撑爆（NODE_OPTIONS=--max-old-space-size=768，FATAL 稳定落在 07:51 前后），
 *   堆溢出是致命错误、try/catch 接不住，进程被 pm2 重启 —— 于是 Step 3.6 一次都没跑到过
 *   （pm2 日志实测：`Step 3` 出现 14 次，`Step 3.6` / `All done in` 各 0 次）。
 *   后果是 RW/LH/LB 的 paid 桶长期冻结：最新 paid 订单日 LB 停在 2026-02-24、
 *   RW 2026-03-05、LH 2026-06-07，而支付 API 的实际打款已到 2026-09-11，
 *   结算页「结算率」因此被严重低估（LB 1.83% / RW 7.32% / LH 9.69%）。
 *
 * 与 D-314.3 的区别：打款同步能靠「前移到交易同步之前」躲开 OOM，剖分不能——
 * 它改的正是交易同步刚写完的行，必须排在交易同步之后。所以只能拆成独立进程周期。
 *
 * 幂等：剖分只把已存在且未删除的行 status→'paid'，不新建行、不改金额、不复活软删行，
 * 重复跑无副作用（第二次 affected=0）。
 */

function verifyCron(req: NextRequest): boolean {
  const secret = process.env.CRON_SECRET;
  if (!secret) return false;
  return req.headers.get("authorization") === `Bearer ${secret}`;
}

function log(msg: string) {
  console.error(`[CRON paid-carve ${new Date().toISOString()}] ${msg}`);
}

export async function GET(req: NextRequest) {
  if (!verifyCron(req)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const t0 = Date.now();
  log("开始 RW/LH/LB 已付剖分...");

  try {
    const { markPaidFromPaymentDetails } = await import("@/lib/affiliate-paid-carve");
    const users = await prisma.users.findMany({
      where: { is_deleted: 0, status: "active", role: { in: ["user", "leader"] } },
      select: { id: true, username: true },
    });

    let totalMarked = 0;
    let totalWithdrawals = 0;
    let totalSignIds = 0;
    const errors: string[] = [];
    const perUser: Record<string, unknown> = {};

    for (const user of users) {
      try {
        const carve = await markPaidFromPaymentDetails(user.id);
        totalMarked += carve.rows_marked_paid;
        totalWithdrawals += carve.scanned_withdrawals;
        totalSignIds += carve.detail_signids;
        if (carve.errors.length > 0) errors.push(...carve.errors);
        if (carve.rows_marked_paid > 0 || carve.errors.length > 0) {
          perUser[user.username] = {
            marked: carve.rows_marked_paid,
            signids: carve.detail_signids,
            withdrawals: carve.scanned_withdrawals,
            by_platform: carve.by_platform,
            errors: carve.errors.length,
          };
          log(`  ${user.username}: 标记 ${carve.rows_marked_paid} 笔 paid（明细 ${carve.detail_signids} 行，打款单 ${carve.scanned_withdrawals}）${carve.errors.length ? `，错误 ${carve.errors.length}` : ""}`);
        }
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        errors.push(`${user.username}: ${msg}`);
        log(`  ${user.username} error: ${msg}`);
      }
    }

    const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
    log(`全部完成：共标记 ${totalMarked} 笔 paid，耗时 ${elapsed}s`);

    return NextResponse.json({
      ok: true,
      users_scanned: users.length,
      rows_marked_paid: totalMarked,
      scanned_withdrawals: totalWithdrawals,
      detail_signids: totalSignIds,
      errors: errors.slice(0, 50),
      error_count: errors.length,
      per_user: perUser,
      elapsed_s: +elapsed,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log(`剖分整体失败: ${msg}`);
    return NextResponse.json({ ok: false, error: msg }, { status: 500 });
  }
}
