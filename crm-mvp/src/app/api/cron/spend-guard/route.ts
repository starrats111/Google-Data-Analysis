import { NextRequest, NextResponse } from "next/server";
import prisma from "@/lib/prisma";
import { syncFromSheet } from "@/lib/sheet-sync";
import { getExchangeRate } from "@/lib/exchange-rate";
import { nowCST } from "@/lib/date-utils";
import { parseCampaignNameFull } from "@/lib/campaign-merchant-link";
import { normalizePlatformCode } from "@/lib/constants";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

/**
 * D-190 花费哨兵（对齐 Hermes HM-D36）：零出单超线的测试期系列，自动止损暂停。
 *
 * 背景：CRM 此前没有任何自动止损；Hermes 侧 #49 polarde 实证 $9 线冲到 $10.97 才被
 * 整点巡检发现。07 拍板不高频直查 Ads API——花费从 MCC 脚本维护的 Google Sheet 读
 * （脚本错开半小时一跑，Sheet 保鲜 ≈15-30 分钟），本 cron 每 15 分钟消费一轮。
 *
 * 判定（全部满足才动手）：
 *   1. ENABLED、未删除、创建时间在测试窗口内（默认 14 天——老系列语义不同，不追溯）
 *   2. 零出单双保险：ads_daily_stats 的 orders/commission 累计全 0，且商家维度
 *      affiliate_transactions 自建系列前 1 天起无任何一笔（防 campaign 级归因缺失误杀）
 *   3. 累计花费（历史 ads_daily_stats + 今日 Sheet 实时值，币种按汇率表转 USD）≥ 止损线
 *
 * 动作：Google Ads mutate 暂停（MCC 自有凭据缺失时 client 内部走组 Token 池兜底）+
 *   更新 google_status + 记 spend_guard_actions + 用户站内通知（每轮每用户合并一条）+ 飞书群汇总。
 *
 * 防死循环：spend_guard_actions.campaign_id 唯一——每个系列只自动止损一次，用户手动
 *   重启后哨兵不再碰它；mutate 失败重试最多 3 次。每轮暂停上限防失控。
 *
 * 配置（环境变量）：
 *   SPEND_GUARD_ENABLED      默认开（设 "0" 关闭）
 *   SPEND_GUARD_CAP_USD      止损线，默认 9
 *   SPEND_GUARD_WINDOW_DAYS  测试窗口天数，默认 14
 *   SPEND_GUARD_MAX_PAUSES   每轮暂停上限，默认 40
 *
 * 调试：GET ?dry=1 只评估不动作，返回将被暂停的清单。
 */

function verifyCron(req: NextRequest): boolean {
  const secret = process.env.CRON_SECRET;
  if (!secret) return false;
  return req.headers.get("authorization") === `Bearer ${secret}`;
}

function log(msg: string) {
  console.error(`[CRON spend-guard ${new Date().toISOString()}] ${msg}`);
}

type CandidateRow = {
  id: bigint;
  user_id: bigint;
  mcc_id: bigint | null;
  customer_id: string | null;
  google_campaign_id: string | null;
  campaign_name: string | null;
  daily_budget: string; // decimal as string
  created_at: Date;
  username: string;
  aff_mid: string | null;
  aff_platform: string | null;
  hist_cost: string;
  hist_orders: bigint | number;
  hist_comm: string;
};

type PauseTarget = {
  c: CandidateRow;
  totalCost: number;
  todayCost: number | null; // null = 该轮 Sheet 不可用，仅凭历史花费判定
};

export async function GET(req: NextRequest) {
  if (!verifyCron(req)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  if (process.env.SPEND_GUARD_ENABLED === "0") {
    return NextResponse.json({ ok: true, skipped: "disabled" });
  }

  const capUsd = Number(process.env.SPEND_GUARD_CAP_USD || 9);
  const windowDays = Math.max(1, Math.floor(Number(process.env.SPEND_GUARD_WINDOW_DAYS || 14)));
  const maxPauses = Math.max(1, Math.floor(Number(process.env.SPEND_GUARD_MAX_PAUSES || 40)));
  const dry = req.nextUrl.searchParams.get("dry") === "1";
  const today = nowCST().format("YYYY-MM-DD");
  const startedAt = Date.now();

  // ---------- 1. 候选：窗口内 ENABLED、零出单（日表口径）、花费可能过线、哨兵没处理过 ----------
  // 今日花费单独从 Sheet 取，历史只累计到昨日（date < today），避免与手动同步写入的今日行重复计
  // 「可能过线」预筛：今日花费理论上限按 2×日预算估（Google 单日最多按 2 倍日预算超投）
  const candidates: CandidateRow[] = await prisma.$queryRawUnsafe(`
    SELECT c.id, c.user_id, c.mcc_id, c.customer_id, c.google_campaign_id, c.campaign_name,
           c.daily_budget, c.created_at, u.username,
           um.merchant_id AS aff_mid, um.platform AS aff_platform,
           COALESCE(h.cost, 0)   AS hist_cost,
           COALESCE(h.orders, 0) AS hist_orders,
           COALESCE(h.comm, 0)   AS hist_comm
    FROM campaigns c
    JOIN users u ON u.id = c.user_id
    LEFT JOIN user_merchants um ON um.id = c.user_merchant_id AND um.is_deleted = 0
    LEFT JOIN (
      SELECT campaign_id, SUM(cost) AS cost, SUM(orders) AS orders, SUM(commission) AS comm
      FROM ads_daily_stats
      WHERE is_deleted = 0 AND date < '${today}'
      GROUP BY campaign_id
    ) h ON h.campaign_id = c.id
    WHERE c.is_deleted = 0
      AND c.google_status = 'ENABLED'
      AND c.google_campaign_id IS NOT NULL
      AND c.mcc_id IS NOT NULL
      AND c.created_at >= DATE_SUB(NOW(), INTERVAL ${windowDays} DAY)
      AND NOT EXISTS (
        SELECT 1 FROM spend_guard_actions a
        WHERE a.campaign_id = c.id AND (a.status = 'paused' OR a.attempts >= 3)
      )
      AND COALESCE(h.orders, 0) = 0
      AND COALESCE(h.comm, 0) = 0
      AND (COALESCE(h.cost, 0) + 2 * c.daily_budget) >= ${capUsd}
    ORDER BY hist_cost DESC
    LIMIT 300
  `);

  log(`窗口 ${windowDays} 天 / 止损线 $${capUsd}：日表口径候选 ${candidates.length} 个`);

  // ---------- 2. 零出单双保险：商家维度交易查一遍（归因缺失时 campaign 日表会假零单） ----------
  const zeroOrder: CandidateRow[] = [];
  let skippedHasTxn = 0;
  let skippedNoMerchant = 0;
  for (const c of candidates) {
    let platform = c.aff_platform;
    let mid = c.aff_mid;
    if (!platform || !mid) {
      const parsed = parseCampaignNameFull(c.campaign_name || "");
      if (parsed) {
        platform = normalizePlatformCode(parsed.platform);
        mid = parsed.mid;
      }
    }
    if (!platform || !mid) {
      // 连商家都定位不到，无法核实出单情况——宁可不动
      skippedNoMerchant++;
      continue;
    }
    const since = new Date(c.created_at.getTime() - 24 * 3600 * 1000);
    const txns = await prisma.affiliate_transactions.count({
      where: {
        user_id: c.user_id,
        platform,
        merchant_id: mid,
        is_deleted: 0,
        transaction_time: { gte: since },
      },
    });
    if (txns > 0) {
      skippedHasTxn++;
      continue;
    }
    zeroOrder.push(c);
  }
  log(`零出单核实：${zeroOrder.length} 个（商家有交易跳过 ${skippedHasTxn}，定位不到商家跳过 ${skippedNoMerchant}）`);

  // ---------- 3. 今日花费：按 MCC 拉 Sheet 当日行（MCC 脚本半小时一更，最鲜数据） ----------
  const mccIds = [...new Set(zeroOrder.map((c) => c.mcc_id!.toString()))];
  const mccs = await prisma.google_mcc_accounts.findMany({
    where: { id: { in: mccIds.map((v) => BigInt(v)) }, is_deleted: 0 },
  });
  const mccById = new Map(mccs.map((m) => [m.id.toString(), m]));

  // gcid -> 今日花费 USD；MCC 拉取失败则整个 MCC 不在 map（该 MCC 只凭历史花费判定）
  const todayCostByGcid = new Map<string, number>();
  const sheetOkMccs = new Set<string>();
  const sheetFails: string[] = [];
  const CONCURRENCY = 4;
  for (let i = 0; i < mccs.length; i += CONCURRENCY) {
    const batch = mccs.slice(i, i + CONCURRENCY);
    await Promise.all(batch.map(async (m) => {
      if (!m.sheet_url) { sheetFails.push(`${m.mcc_name || m.mcc_id}: 无 Sheet URL`); return; }
      try {
        const r = await syncFromSheet(m.sheet_url, today, today);
        if (!r.success) throw new Error(r.message || "读取失败");
        const rate = await getExchangeRate(m.currency, today);
        if (rate <= 0) throw new Error(`汇率不可用（${m.currency}）`);
        for (const row of r.rows) {
          todayCostByGcid.set(row.campaign_id, (todayCostByGcid.get(row.campaign_id) || 0) + row.cost * rate);
        }
        sheetOkMccs.add(m.id.toString());
      } catch (err) {
        sheetFails.push(`${m.mcc_name || m.mcc_id}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }));
  }
  log(`Sheet 今日花费：成功 ${sheetOkMccs.size}/${mccs.length} 个 MCC${sheetFails.length ? `，失败：${sheetFails.join("；")}` : ""}`);

  // ---------- 4. 判线 ----------
  const targets: PauseTarget[] = [];
  for (const c of zeroOrder) {
    const hist = Number(c.hist_cost);
    const sheetOk = sheetOkMccs.has(c.mcc_id!.toString());
    const todayCost = sheetOk ? (todayCostByGcid.get(c.google_campaign_id!) || 0) : null;
    const totalCost = hist + (todayCost || 0);
    if (totalCost >= capUsd) targets.push({ c, totalCost, todayCost });
  }
  targets.sort((a, b) => b.totalCost - a.totalCost);
  const overflow = Math.max(0, targets.length - maxPauses);
  const toPause = targets.slice(0, maxPauses);

  if (dry) {
    return NextResponse.json({
      ok: true, dry: true, cap_usd: capUsd, window_days: windowDays,
      candidates: candidates.length, zero_order: zeroOrder.length,
      would_pause: toPause.map((t) => ({
        campaign_id: t.c.id.toString(), user: t.c.username, name: t.c.campaign_name,
        total_cost: Math.round(t.totalCost * 100) / 100,
        today_cost: t.todayCost == null ? null : Math.round(t.todayCost * 100) / 100,
      })),
      deferred_next_round: overflow,
      sheet_fails: sheetFails,
      elapsed_ms: Date.now() - startedAt,
    });
  }

  // ---------- 5. 逐个暂停 ----------
  const { updateCampaignStatus } = await import("@/lib/google-ads");
  const paused: PauseTarget[] = [];
  const failed: { t: PauseTarget; error: string }[] = [];
  for (const t of toPause) {
    const m = mccById.get(t.c.mcc_id!.toString());
    if (!m) { failed.push({ t, error: "MCC 不存在" }); continue; }
    const credentials = {
      mcc_id: m.mcc_id,
      developer_token: m.developer_token || "",
      service_account_json: m.service_account_json || "",
    };
    const r = await updateCampaignStatus(
      credentials,
      (t.c.customer_id || "").replace(/-/g, ""),
      t.c.google_campaign_id!,
      "PAUSED",
    );
    if (r.success) {
      await prisma.campaigns.update({
        where: { id: t.c.id },
        data: { google_status: "PAUSED", last_google_sync_at: new Date() },
      });
      await prisma.spend_guard_actions.upsert({
        where: { campaign_id: t.c.id },
        update: { status: "paused", cost_usd: t.totalCost, cap_usd: capUsd, last_error: null },
        create: { campaign_id: t.c.id, user_id: t.c.user_id, status: "paused", cost_usd: t.totalCost, cap_usd: capUsd },
      });
      paused.push(t);
      log(`已暂停 #${t.c.id} ${t.c.campaign_name}（$${t.totalCost.toFixed(2)} ≥ $${capUsd}，零出单）`);
    } else {
      await prisma.spend_guard_actions.upsert({
        where: { campaign_id: t.c.id },
        update: { status: "pause_failed", attempts: { increment: 1 }, last_error: r.message.slice(0, 500) },
        create: { campaign_id: t.c.id, user_id: t.c.user_id, status: "pause_failed", cost_usd: t.totalCost, cap_usd: capUsd, last_error: r.message.slice(0, 500) },
      });
      failed.push({ t, error: r.message });
      log(`暂停失败 #${t.c.id} ${t.c.campaign_name}: ${r.message}`);
    }
  }

  // ---------- 6. 通知：每用户合并一条站内通知 + 飞书群汇总 ----------
  const byUser = new Map<string, PauseTarget[]>();
  for (const t of paused) {
    const k = t.c.user_id.toString();
    if (!byUser.has(k)) byUser.set(k, []);
    byUser.get(k)!.push(t);
  }
  for (const [uid, list] of byUser) {
    const lines = list.map((t) =>
      `· ${t.c.campaign_name}：累计花费 $${t.totalCost.toFixed(2)} ≥ 止损线 $${capUsd}，零出单`);
    await prisma.notifications.create({
      data: {
        user_id: BigInt(uid),
        type: "alert",
        title: `花费哨兵：自动暂停 ${list.length} 个零出单超线系列`,
        content: [
          `以下测试系列累计花费已超止损线（$${capUsd}）且从未出单，已自动暂停：`,
          ``,
          ...lines,
          ``,
          `如确认要继续投放，可在「数据中心」手动重新启用——哨兵对同一系列只自动暂停一次，重启后不会再碰它。`,
        ].join("\n"),
        metadata: JSON.stringify({
          source: "D-190 spend-guard",
          campaign_ids: list.map((t) => t.c.id.toString()),
          cap_usd: capUsd,
        }),
      },
    });
  }
  if (paused.length > 0 || failed.length > 0) {
    const { sendAlert } = await import("@/lib/alert");
    const byUserText = [...byUser.values()]
      .map((list) => `${list[0].c.username}×${list.length}`).join("、") || "无";
    void sendAlert({
      level: failed.length > 0 ? "warning" : "info",
      title: `花费哨兵：自动暂停 ${paused.length} 个零出单超线系列`,
      content: [
        `止损线 $${capUsd} / 测试窗口 ${windowDays} 天`,
        `按用户：${byUserText}`,
        ...(failed.length > 0 ? [`⚠️ 暂停失败 ${failed.length} 个（将重试，≤3 次）：${failed.map((f) => `${f.t.c.campaign_name}(${f.error.slice(0, 60)})`).join("；")}`] : []),
        ...(overflow > 0 ? [`另有 ${overflow} 个超线待下轮处理（每轮上限 ${maxPauses}）`] : []),
        ...(sheetFails.length > 0 ? [`Sheet 读取失败 ${sheetFails.length} 个 MCC（相关系列仅按历史花费判定）`] : []),
      ].join("\n"),
      source: "cron/spend-guard",
    });
  }

  const result = {
    ok: true,
    cap_usd: capUsd,
    window_days: windowDays,
    candidates: candidates.length,
    zero_order: zeroOrder.length,
    paused: paused.length,
    pause_failed: failed.length,
    deferred_next_round: overflow,
    users_notified: byUser.size,
    sheet_fails: sheetFails.length,
    elapsed_ms: Date.now() - startedAt,
  };
  log(`完成：${JSON.stringify(result)}`);
  return NextResponse.json(result);
}
