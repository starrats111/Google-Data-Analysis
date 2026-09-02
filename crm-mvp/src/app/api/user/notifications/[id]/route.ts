import { NextRequest, NextResponse } from "next/server";
import prisma from "@/lib/prisma";
import { getUserFromRequest, serializeData } from "@/lib/auth";
import { todayCST } from "@/lib/date-utils";

/**
 * D-309：亏损提醒的「点击查看详情」以前点开是空白弹窗——详情弹窗只认商家清单变更那一种
 * metadata 结构（removed/added/statusChanged/invalidLinks），D-191 亏损提醒的 metadata 里
 * 只有 loss_campaign_ids / zero_campaign_ids 两组 ID，四个分支一个都不命中。
 *
 * 这里按 ID 回查系列明细，拼成前端能直接渲染的表格数据。
 * 口径与 cron/loss-digest 保持一致：净利 = 佣金 − 拒付佣金 − 花费。
 *
 * 注意：回查的是**当前**数据，不是发通知那一刻的快照（通知里的原文仍保留在 content 中）。
 * 用户是拿这张表去决定「现在关不关」，当前数据才是他要的；发通知时的数字看正文原文。
 */

type CampaignDetailRow = {
  id: bigint;
  campaign_name: string | null;
  google_status: string;
  created_at: Date;
  total_cost: string;
  total_orders: bigint | number;
  total_comm: string;
  total_rejected: string;
  last_order_date: Date | null;
  recent_cost: string;
};

/** 把 metadata 里的系列 ID 回查成明细行；查不到的（已删/不属于本人）计入 missing */
async function loadLossDigestDetail(
  userId: bigint,
  lossIds: string[],
  zeroIds: string[],
  activeDays: number,
) {
  // 只接受纯数字 ID，拼进 SQL 前先过一遍，防注入
  const sanitize = (arr: unknown) =>
    (Array.isArray(arr) ? arr : [])
      .map((v) => String(v))
      .filter((v) => /^\d+$/.test(v));

  const loss = sanitize(lossIds);
  const zero = sanitize(zeroIds);
  const all = [...new Set([...loss, ...zero])];
  if (all.length === 0) return null;

  const today = todayCST();
  const idList = all.join(",");

  const rows: CampaignDetailRow[] = await prisma.$queryRawUnsafe(`
    SELECT c.id, c.campaign_name, c.google_status, c.created_at,
           COALESCE(h.cost, 0)     AS total_cost,
           COALESCE(h.orders, 0)   AS total_orders,
           COALESCE(h.comm, 0)     AS total_comm,
           COALESCE(h.rejected, 0) AS total_rejected,
           h.last_order_date,
           COALESCE(h.recent_cost, 0) AS recent_cost
    FROM campaigns c
    LEFT JOIN (
      SELECT campaign_id,
             SUM(cost) AS cost, SUM(orders) AS orders,
             SUM(commission) AS comm, SUM(rejected_commission) AS rejected,
             MAX(CASE WHEN orders > 0 THEN date END) AS last_order_date,
             SUM(CASE WHEN date >= DATE_SUB('${today}', INTERVAL ${activeDays - 1} DAY) THEN cost ELSE 0 END) AS recent_cost
      FROM ads_daily_stats
      WHERE is_deleted = 0 AND date <= '${today}' AND campaign_id IN (${idList})
      GROUP BY campaign_id
    ) h ON h.campaign_id = c.id
    WHERE c.is_deleted = 0 AND c.user_id = ${userId.toString()} AND c.id IN (${idList})
  `);

  const lossSet = new Set(loss);
  const detail = rows.map((r) => {
    const cost = Number(r.total_cost || 0);
    const commission = Number(r.total_comm || 0) - Number(r.total_rejected || 0);
    return {
      campaignId: r.id.toString(),
      name: r.campaign_name || `#${r.id}`,
      status: r.google_status,
      group: lossSet.has(r.id.toString()) ? ("loss" as const) : ("zero" as const),
      cost,
      commission,
      orders: Number(r.total_orders || 0),
      net: commission - cost,
      roi: cost > 0 ? (commission - cost) / cost : null,
      lastOrder: r.last_order_date
        ? new Date(r.last_order_date).toISOString().slice(0, 10)
        : null,
      recentCost: Number(r.recent_cost || 0),
    };
  });

  // 亏得最狠的排最前，跟通知正文一个顺序
  detail.sort((a, b) => a.net - b.net);

  return { rows: detail, missing: all.length - detail.length, activeDays };
}

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const user = getUserFromRequest(req);
  if (!user) return NextResponse.json({ code: 401, message: "未登录" });

  const { id } = await params;

  const notif = await prisma.notifications.findFirst({
    where: { id: BigInt(id), user_id: BigInt(user.userId), is_deleted: 0 },
  });

  if (!notif) {
    return NextResponse.json({ code: 404, message: "通知不存在" });
  }

  let metadata: Record<string, unknown> | null = null;
  if (notif.metadata) {
    try { metadata = JSON.parse(notif.metadata); } catch { /* ignore */ }
  }

  // D-309：亏损提醒补明细。回查失败不能拖垮详情本身——正文原文仍然看得到
  if (metadata && (metadata.loss_campaign_ids || metadata.zero_campaign_ids)) {
    const activeDays = Math.max(1, Math.floor(Number(process.env.LOSS_DIGEST_ACTIVE_DAYS || 7)));
    try {
      const lossDigest = await loadLossDigestDetail(
        BigInt(user.userId),
        metadata.loss_campaign_ids as string[],
        metadata.zero_campaign_ids as string[],
        activeDays,
      );
      if (lossDigest) metadata = { ...metadata, lossDigest };
    } catch (e) {
      console.error("[notifications] 亏损提醒明细回查失败:", e);
    }
  }

  if (notif.is_read === 0) {
    await prisma.notifications.update({
      where: { id: notif.id },
      data: { is_read: 1 },
    });
  }

  return NextResponse.json({
    code: 0,
    data: { ...serializeData(notif), metadata },
  });
}
