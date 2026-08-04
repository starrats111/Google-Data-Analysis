import { NextRequest, NextResponse } from "next/server";
import prisma from "@/lib/prisma";
import { nowCST } from "@/lib/date-utils";
import { sendAlert } from "@/lib/alert";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

/**
 * D-191 每日亏损提醒：把「还在跑但一直在亏」的系列，每天推给系列归属人。
 *
 * 背景（2026-07-27 止损审计）：CRM 侧 119 个 ENABLED 系列累计净亏 -$1754 无人处理。
 * 07 定的口径是 CRM 不自动止损、全部手动关停（与 Hermes 不同），所以这里只提醒不动手，
 * 由归属人自己在数据中心决定关还是继续养。
 *
 * 两类提醒：
 *   A 有单亏损：有过订单，但净利（佣金 − 拒付佣金 − 花费）亏到线以下——这类最容易被漏，
 *     出过单看着像在赚，实际一直倒贴（Hermes #22 hobobags 一路亏到 -$23 就是这个形态）
 *   B 零出单超线：从没出过单、花费已过止损线还开着——哨兵停不掉的（MCC 凭据缺失等）都在这
 *
 * 推送：每个用户一条站内通知（notifications，type=alert）+ 飞书群一条按人汇总。
 *
 * 配置：
 *   LOSS_DIGEST_ENABLED    默认开（设 "0" 关闭）
 *   LOSS_DIGEST_MIN_USD    有单亏损的提醒线，默认 3（净亏超过它才提）
 *   LOSS_DIGEST_ZERO_CAP   零出单花费线，默认 9（与 SPEND_GUARD_CAP_USD 同口径）
 *   LOSS_DIGEST_MAX_ROWS   单个用户列出的系列数上限，默认 15（其余折叠成一行合计）
 *
 * 调试：GET ?dry=1 只算不推，返回完整清单。
 */

function verifyCron(req: NextRequest): boolean {
  const secret = process.env.CRON_SECRET;
  if (!secret) return false;
  return req.headers.get("authorization") === `Bearer ${secret}`;
}

type LossRow = {
  id: bigint;
  user_id: bigint;
  campaign_name: string | null;
  customer_id: string | null;
  created_at: Date;
  username: string;
  total_cost: string;
  total_orders: bigint | number;
  total_comm: string;
  total_rejected: string;
  last_order_date: Date | null;
  recent_cost: string;
};

type Item = {
  campaignId: string;
  name: string;
  cost: number;
  commission: number;
  orders: number;
  net: number;
  roi: number | null;
  days: number;
  lastOrder: string | null;
  recentCost: number;
};

const money = (n: number) => `$${n.toFixed(2)}`;

function toItem(r: LossRow): Item {
  const cost = Number(r.total_cost || 0);
  const commission = Number(r.total_comm || 0) - Number(r.total_rejected || 0);
  const net = commission - cost;
  const days = Math.max(
    1,
    Math.floor((Date.now() - new Date(r.created_at).getTime()) / 86_400_000),
  );
  return {
    campaignId: r.id.toString(),
    name: r.campaign_name || `#${r.id}`,
    cost,
    commission,
    orders: Number(r.total_orders || 0),
    net,
    roi: cost > 0 ? (commission - cost) / cost : null,
    days,
    lastOrder: r.last_order_date ? new Date(r.last_order_date).toISOString().slice(0, 10) : null,
    recentCost: Number(r.recent_cost || 0),
  };
}

export async function GET(req: NextRequest) {
  if (!verifyCron(req)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  if (process.env.LOSS_DIGEST_ENABLED === "0") {
    return NextResponse.json({ ok: true, skipped: "disabled" });
  }

  const minLoss = Number(process.env.LOSS_DIGEST_MIN_USD || 3);
  const zeroCap = Number(process.env.LOSS_DIGEST_ZERO_CAP || process.env.SPEND_GUARD_CAP_USD || 9);
  const maxRows = Math.max(3, Math.floor(Number(process.env.LOSS_DIGEST_MAX_ROWS || 15)));
  // 近 N 天没花过钱的（预算耗尽/没量的老系列）不逐条列，只报个数——首轮实测全量是
  // 429 个系列 / -$8372，全推出去就是一堵噪音墙，人只会直接忽略
  const activeDays = Math.max(1, Math.floor(Number(process.env.LOSS_DIGEST_ACTIVE_DAYS || 7)));
  const dry = req.nextUrl.searchParams.get("dry") === "1";
  const today = nowCST().format("YYYY-MM-DD");
  const startedAt = Date.now();

  // 净利口径与数据中心一致：佣金 − 拒付佣金 − 花费
  const baseSelect = `
    SELECT c.id, c.user_id, c.campaign_name, c.customer_id, c.created_at, u.username,
           COALESCE(h.cost, 0)     AS total_cost,
           COALESCE(h.orders, 0)   AS total_orders,
           COALESCE(h.comm, 0)     AS total_comm,
           COALESCE(h.rejected, 0) AS total_rejected,
           h.last_order_date,
           COALESCE(h.recent_cost, 0) AS recent_cost
    FROM campaigns c
    JOIN users u ON u.id = c.user_id AND u.is_deleted = 0
    LEFT JOIN (
      SELECT campaign_id,
             SUM(cost) AS cost, SUM(orders) AS orders,
             SUM(commission) AS comm, SUM(rejected_commission) AS rejected,
             MAX(CASE WHEN orders > 0 THEN date END) AS last_order_date,
             SUM(CASE WHEN date >= DATE_SUB('${today}', INTERVAL ${activeDays - 1} DAY) THEN cost ELSE 0 END) AS recent_cost
      FROM ads_daily_stats
      WHERE is_deleted = 0 AND date <= '${today}'
      GROUP BY campaign_id
    ) h ON h.campaign_id = c.id
    WHERE c.is_deleted = 0 AND c.google_status = 'ENABLED'
  `;

  const lossRows: LossRow[] = await prisma.$queryRawUnsafe(`
    ${baseSelect}
      AND COALESCE(h.orders, 0) > 0
      AND (COALESCE(h.comm, 0) - COALESCE(h.rejected, 0) - COALESCE(h.cost, 0)) <= -${minLoss}
    ORDER BY (COALESCE(h.comm, 0) - COALESCE(h.rejected, 0) - COALESCE(h.cost, 0)) ASC
    LIMIT 500
  `);

  const zeroRows: LossRow[] = await prisma.$queryRawUnsafe(`
    ${baseSelect}
      AND COALESCE(h.orders, 0) = 0
      AND COALESCE(h.comm, 0) = 0
      AND COALESCE(h.cost, 0) >= ${zeroCap}
    ORDER BY COALESCE(h.cost, 0) DESC
    LIMIT 500
  `);

  // 按人分组
  const byUser = new Map<string, { username: string; loss: Item[]; zero: Item[] }>();
  const bucket = (r: LossRow) => {
    const key = r.user_id.toString();
    let b = byUser.get(key);
    if (!b) {
      b = { username: r.username, loss: [], zero: [] };
      byUser.set(key, b);
    }
    return b;
  };
  for (const r of lossRows) bucket(r).loss.push(toItem(r));
  for (const r of zeroRows) bucket(r).zero.push(toItem(r));

  const summarize = (items: Item[]) => ({
    count: items.length,
    net: items.reduce((s, i) => s + i.net, 0),
    cost: items.reduce((s, i) => s + i.cost, 0),
  });

  const lines = (items: Item[]) => {
    const shown = items.slice(0, maxRows).map((i) => {
      const roiText = i.roi != null ? `ROI ${i.roi.toFixed(2)}` : "ROI —";
      const orderText = i.orders > 0
        ? `${i.orders} 单，末单 ${i.lastOrder || "—"}`
        : "零出单";
      return `· ${i.name}｜花费 ${money(i.cost)} / 佣金 ${money(i.commission)} → 净 ${money(i.net)}（${roiText}，${orderText}，近 ${activeDays} 天花 ${money(i.recentCost)}）`;
    });
    const rest = items.slice(maxRows);
    if (rest.length) {
      shown.push(`· …另有 ${rest.length} 个，合计净 ${money(rest.reduce((s, i) => s + i.net, 0))}`);
    }
    return shown;
  };

  const perUserSummary: Array<{
    userId: string; username: string;
    lossCount: number; zeroCount: number; dormantCount: number; net: number; activeNet: number;
  }> = [];
  let notified = 0;

  for (const [uid, b] of byUser) {
    // 还在花钱的先说，睡着的只报个数——同样是亏，今天还在烧的才需要今天处理
    const spending = (items: Item[]) => items.filter((i) => i.recentCost > 0);
    const idle = (items: Item[]) => items.filter((i) => i.recentCost <= 0);
    const loss = spending(b.loss);
    const zero = spending(b.zero);
    const dormant = [...idle(b.loss), ...idle(b.zero)];
    const sl = summarize(loss);
    const sz = summarize(zero);
    const sd = summarize(dormant);
    perUserSummary.push({
      userId: uid,
      username: b.username,
      lossCount: sl.count,
      zeroCount: sz.count,
      dormantCount: sd.count,
      net: sl.net + sz.net + sd.net,
      activeNet: sl.net + sz.net,
    });
    if (dry || (!sl.count && !sz.count)) continue;

    const body: string[] = [
      `你名下有 ${sl.count + sz.count} 个系列**近 ${activeDays} 天还在花钱、但一直是亏的**，合计净 ${money(sl.net + sz.net)}。CRM 不会自动关停，请自己判断留还是关。`,
      ``,
    ];
    if (sl.count) {
      body.push(`【有单但亏损】${sl.count} 个，合计净 ${money(sl.net)}（出过单容易看着像在赚，实际一直倒贴）：`, ...lines(loss), ``);
    }
    if (sz.count) {
      body.push(`【零出单超线】${sz.count} 个，花费共 ${money(sz.cost)}，一单没出还开着：`, ...lines(zero), ``);
    }
    if (sd.count) {
      body.push(`另有 ${sd.count} 个亏损系列近 ${activeDays} 天没花钱（合计净 ${money(sd.net)}），还是 ENABLED 状态，有空一并清一下。`, ``);
    }
    body.push(`处理入口：数据中心 → 找到系列 → 暂停；确认要继续养的可以忽略本条，明天还会提醒。`);

    await prisma.notifications.create({
      data: {
        user_id: BigInt(uid),
        type: "alert",
        title: `每日亏损提醒：${sl.count + sz.count} 个在投系列净亏 ${money(-(sl.net + sz.net))}`,
        content: body.join("\n"),
        metadata: JSON.stringify({
          source: "D-191 loss-digest",
          date: today,
          loss_campaign_ids: loss.map((i) => i.campaignId),
          zero_campaign_ids: zero.map((i) => i.campaignId),
          dormant_count: sd.count,
          min_loss_usd: minLoss,
          zero_cap_usd: zeroCap,
        }),
      },
    });
    notified++;
  }

  perUserSummary.sort((a, b) => a.activeNet - b.activeNet);
  const totalNet = perUserSummary.reduce((s, u) => s + u.net, 0);
  const activeNet = perUserSummary.reduce((s, u) => s + u.activeNet, 0);
  const activeCount = perUserSummary.reduce((s, u) => s + u.lossCount + u.zeroCount, 0);

  if (!dry && perUserSummary.length) {
    void sendAlert({
      level: activeNet <= -50 ? "warning" : "info",
      title: `每日亏损提醒（${today}）：${activeCount} 个还在花钱的亏损系列，净亏 ${money(-activeNet)}`,
      content: [
        `口径：有单亏损线 ${money(minLoss)}｜零出单花费线 ${money(zeroCap)}｜近 ${activeDays} 天有花费才逐条列`,
        `全量（含近 ${activeDays} 天没花钱的）：${lossRows.length + zeroRows.length} 个，净 ${money(totalNet)}`,
        `已给 ${notified} 个人推了站内通知，明细在各自的通知里。`,
        ``,
        ...perUserSummary
          .filter((u) => u.lossCount + u.zeroCount > 0)
          .map((u) => `${u.username}：有单亏损 ${u.lossCount} + 零出单 ${u.zeroCount} 个，净 ${money(u.activeNet)}（另有 ${u.dormantCount} 个已停花费）`),
      ].join("\n"),
      source: "cron/loss-digest",
    });
  }

  return NextResponse.json({
    ok: true,
    dry,
    date: today,
    min_loss_usd: minLoss,
    zero_cap_usd: zeroCap,
    active_days: activeDays,
    loss_campaigns: lossRows.length,
    zero_order_campaigns: zeroRows.length,
    active_campaigns: activeCount,
    total_net_usd: Number(totalNet.toFixed(2)),
    active_net_usd: Number(activeNet.toFixed(2)),
    users_notified: notified,
    per_user: perUserSummary,
    ...(dry
      ? {
        detail: [...byUser.entries()].map(([uid, b]) => ({
          userId: uid,
          username: b.username,
          loss: b.loss.filter((i) => i.recentCost > 0).slice(0, 20),
          zero: b.zero.filter((i) => i.recentCost > 0).slice(0, 20),
        })),
      }
      : {}),
    elapsed_ms: Date.now() - startedAt,
  });
}
