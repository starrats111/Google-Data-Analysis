import { NextRequest, NextResponse } from "next/server";
import prisma from "@/lib/prisma";
import { queryGoogleAds, microsToDollars, type MccCredentials } from "@/lib/google-ads/client";
import { getAnalysisRange } from "@/lib/campaign-analysis";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

/**
 * D-304 出价上限回流（每日 06:30）
 *
 * 病根（2026-09-01 实地探查 wj11 / CID 2189127848 / 系列 24123327540）：
 * Google 后台显示出价上限 $5.20，CRM 弹窗显示 $0.30——差了 17 倍。查下来两处错位：
 *
 *   1. 采集读错字段。原 ads-metrics-sync 读 ad_group.cpc_bid_micros，但线上 2007 条在投
 *      系列 100% 是 MAXIMIZE_CLICKS（GAQL 里 biddingStrategyType = TARGET_SPEND），
 *      自动出价下 ad_group 出价是建广告时留下的僵尸值，Google 出价时根本不看。
 *      真值在 campaign.target_spend.cpc_bid_ceiling_micros。
 *   2. 采集被 Sheet 闸门带停。D-264 起「Sheet 有 ISBudget 列就跳过整个 MCC」，而统一
 *      脚本的 Sheet 有 IS/QS 列、没有出价列，于是 8-25 起 21 个 MCC 的 max_cpc 全线断供，
 *      弹窗退回 campaigns.max_cpc_limit 兜底值——那是建广告那天写下的数，从没被刷新过。
 *
 * 所以出价采集从 ads-metrics-sync 里单拎出来：它的供数来源是 API，与 IS/QS 走 Sheet
 * 无关，不该共用一个跳过条件。本 cron 覆盖**所有**有凭据的 MCC。
 *
 * 写两处：
 *   · campaigns.max_cpc_limit ← 账户币种原值（该列口径即账户币种，D-266 批一）
 *   · ads_daily_stats.max_cpc ← 折美元（该列口径是 USD）；当前快照语义：昨日行必写，
 *     窗口内空值行回填，已有历史快照不覆盖
 *
 * ⚠️ 不碰 last_google_sync_at：那一列的语义是「状态最后一次跟 Google 核对过」，
 * campaign-status-drift 靠它判断「已暂停却还在花钱」。本 cron 不读状态，碰它等于伪造证词。
 *
 * 参数：
 *   ?scope=active（默认）窗口内有花费的系列——分析要用的就是这些
 *   ?scope=all          再并上所有 ENABLED 系列，用于存量回刷（960 个 CID，一次跑不完）
 *   ?offset=N           从 CID 工作队列的第 N 个开始；触发软时限时返回 nextOffset 供续跑
 */

function verifyCron(req: NextRequest): boolean {
  const secret = process.env.CRON_SECRET;
  if (!secret) return false;
  return req.headers.get("authorization") === `Bearer ${secret}`;
}

function log(msg: string) {
  console.error(`[CRON campaign-bid-sync ${new Date().toISOString()}] ${msg}`);
}

/** CID 间并发度：487 个活跃 CID 串行要跑 6 分钟以上，超出单次 cron 预算 */
const CID_CONCURRENCY = 4;
/** 软时限：留够收尾时间，绝不让 curl -m 280 把连接掐断在写库中途 */
const DEADLINE_MS = 240_000;

interface CampaignRef {
  id: bigint;
  google_campaign_id: string;
  max_cpc_limit: unknown;
}

interface CidTask {
  mccId: string;
  credentials: MccCredentials;
  /** 账户币种 → USD 乘数；<=0 表示汇率不可用 */
  usdRate: number;
  cid: string;
  refs: CampaignRef[];
}

/**
 * 自动出价策略的上限字段容器（与 mutate.ts 的 CEILING_CONTAINER 同一套口径）。
 * MANUAL_CPC 的出价在 ad_group 上，不在这里；MAXIMIZE_CONVERSIONS 之类没有上限概念。
 */
const CEILING_SELECT = [
  "campaign.target_spend.cpc_bid_ceiling_micros",
  "campaign.percent_cpc.cpc_bid_ceiling_micros",
].join(", ");

/** 从一行 campaign 结果里取出出价上限（账户币种金额）；取不到返回 null */
function readCeiling(campaign: Record<string, unknown> | undefined): number | null {
  for (const container of [campaign?.targetSpend, campaign?.percentCpc]) {
    const micros = Number((container as Record<string, unknown> | undefined)?.cpcBidCeilingMicros ?? 0);
    if (micros > 0) return microsToDollars(micros);
  }
  return null;
}

/**
 * 一个 CID 下这批系列的出价上限（账户币种）。
 * MANUAL_CPC 系列的出价在 ad_group，需要第二次查询——线上目前没有这种系列，
 * 所以只在确实出现时才发这个请求，不为一个空集合烧配额。
 */
async function collectCidBids(task: CidTask): Promise<Map<string, number>> {
  const bids = new Map<string, number>(); // gcid -> 账户币种金额
  const gcidList = task.refs.map((r) => r.google_campaign_id).join(",");

  const rows = await queryGoogleAds(task.credentials, task.cid, `
    SELECT campaign.id, campaign.bidding_strategy_type, ${CEILING_SELECT}
    FROM campaign
    WHERE campaign.id IN (${gcidList})
  `);

  const manualGcids: string[] = [];
  for (const row of rows) {
    const campaign = row.campaign as Record<string, unknown> | undefined;
    const gcid = String(campaign?.id ?? "");
    if (!gcid) continue;
    if (String(campaign?.biddingStrategyType ?? "") === "MANUAL_CPC") { manualGcids.push(gcid); continue; }
    const ceiling = readCeiling(campaign);
    // 上限未设置（Google 不返回该字段）就是「没有上限」，写 0 会把它伪装成 $0 出价
    if (ceiling != null) bids.set(gcid, ceiling);
  }

  if (manualGcids.length > 0) {
    const agRows = await queryGoogleAds(task.credentials, task.cid, `
      SELECT campaign.id, ad_group.cpc_bid_micros
      FROM ad_group
      WHERE campaign.id IN (${manualGcids.join(",")})
        AND ad_group.status != 'REMOVED'
    `);
    for (const row of agRows) {
      const campaign = row.campaign as Record<string, unknown> | undefined;
      const adGroup = row.adGroup as Record<string, unknown> | undefined;
      const gcid = String(campaign?.id ?? "");
      const bid = microsToDollars(Number(adGroup?.cpcBidMicros ?? 0));
      if (!gcid || bid <= 0) continue;
      if (bid > (bids.get(gcid) || 0)) bids.set(gcid, bid);
    }
  }

  return bids;
}

/** 小并发执行器：按序取任务，最多 limit 个同时在跑 */
async function runPooled<T>(items: T[], limit: number, worker: (item: T) => Promise<void>): Promise<void> {
  let cursor = 0;
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (cursor < items.length) {
      await worker(items[cursor++]);
    }
  });
  await Promise.all(runners);
}

export async function GET(req: NextRequest) {
  if (!verifyCron(req)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const startedAt = Date.now();
  const scopeAll = req.nextUrl.searchParams.get("scope") === "all";
  const offset = Math.max(0, Number(req.nextUrl.searchParams.get("offset") || 0) || 0);

  const range = getAnalysisRange(7);
  const { getExchangeRate } = await import("@/lib/exchange-rate");
  const { todayCST, dateColumnStart } = await import("@/lib/date-utils");
  const yesterdayDate = dateColumnStart(range.endStr);
  const todayForRate = todayCST();

  const stats = {
    scope: scopeAll ? "all" : "active",
    offset,
    mccs: 0, cids: 0, cidsDone: 0, campaignsUpdated: 0, statRowsUpdated: 0,
    skippedMccs: 0, timedOut: false, nextOffset: null as number | null,
    errors: [] as string[],
  };

  // ─── 1. 组工作队列：所有有凭据的 MCC × 其名下待核对的 CID ───
  const mccs = await prisma.google_mcc_accounts.findMany({
    where: { is_deleted: 0 },
    select: {
      id: true, user_id: true, mcc_id: true,
      developer_token: true, service_account_json: true, currency: true,
    },
    orderBy: { id: "asc" },
  });

  const tasks: CidTask[] = [];
  for (const mcc of mccs) {
    const credentials: MccCredentials = {
      mcc_id: mcc.mcc_id,
      developer_token: mcc.developer_token || "",
      service_account_json: mcc.service_account_json || "",
    };
    if (!credentials.service_account_json) {
      const { poolHasCredentialFor } = await import("@/lib/google-ads/token-pool");
      if (!(await poolHasCredentialFor(mcc.mcc_id))) {
        stats.skippedMccs++;
        continue; // 无凭据，补配后自动覆盖
      }
    }

    // 窗口内有花费的系列（分析用得上的就是这些）
    const activeRows = await prisma.ads_daily_stats.findMany({
      where: {
        user_id: mcc.user_id,
        is_deleted: 0,
        date: { gte: range.dateStart, lt: range.dateEndExclusive },
        cost: { gt: 0 },
      },
      select: { campaign_id: true },
      distinct: ["campaign_id"],
    });
    const activeIds = activeRows.map((r) => r.campaign_id);
    if (activeIds.length === 0 && !scopeAll) continue;

    const campaigns = await prisma.campaigns.findMany({
      where: {
        mcc_id: mcc.id,
        is_deleted: 0,
        NOT: [{ google_campaign_id: null }, { google_campaign_id: "" }, { customer_id: null }, { customer_id: "" }],
        ...(scopeAll
          ? { OR: [{ google_status: "ENABLED" }, { id: { in: activeIds } }] }
          : { id: { in: activeIds } }),
      },
      select: { id: true, google_campaign_id: true, customer_id: true, max_cpc_limit: true },
      orderBy: { id: "asc" },
    });
    if (campaigns.length === 0) continue;
    stats.mccs++;

    // 账户币种 → USD 乘数。汇率不可用时只跳过 ads_daily_stats.max_cpc（USD 口径），
    // campaigns.max_cpc_limit 存的就是账户币种，不受影响，照写。
    const mccCurrency = (mcc.currency || "USD").toUpperCase();
    const usdRate = mccCurrency === "USD" ? 1 : await getExchangeRate(mccCurrency, todayForRate);

    const byCid = new Map<string, CampaignRef[]>();
    for (const c of campaigns) {
      const cid = (c.customer_id || "").replace(/-/g, "");
      if (!cid) continue;
      const arr = byCid.get(cid) || [];
      arr.push({ id: c.id, google_campaign_id: c.google_campaign_id!, max_cpc_limit: c.max_cpc_limit });
      byCid.set(cid, arr);
    }
    for (const [cid, refs] of byCid) {
      tasks.push({ mccId: mcc.mcc_id, credentials, usdRate, cid, refs });
    }
  }

  // 队列顺序稳定（MCC id 升序 → CID 升序），offset 才有续跑的意义
  tasks.sort((a, b) => (a.mccId === b.mccId ? a.cid.localeCompare(b.cid) : a.mccId.localeCompare(b.mccId)));
  stats.cids = tasks.length;
  const slice = tasks.slice(offset);

  // ─── 2. 逐 CID 核对并回写 ───
  await runPooled(slice, CID_CONCURRENCY, async (task) => {
    if (Date.now() - startedAt > DEADLINE_MS) { stats.timedOut = true; return; }
    stats.cidsDone++;
    try {
      const bids = await collectCidBids(task);
      if (bids.size === 0) return;

      for (const ref of task.refs) {
        const bidAccount = bids.get(ref.google_campaign_id);
        if (bidAccount == null) continue;

        // 1) 系列上的出价上限：账户币种原值，变了才写
        const accountValue = Number(bidAccount.toFixed(4));
        if (Number(ref.max_cpc_limit ?? -1) !== accountValue) {
          await prisma.campaigns.update({
            where: { id: ref.id },
            data: { max_cpc_limit: accountValue },
          });
          stats.campaignsUpdated++;
        }

        // 2) 逐日快照：昨日必写，窗口内空值回填；历史已有快照不覆盖
        if (task.usdRate <= 0) continue;
        const updated = await prisma.ads_daily_stats.updateMany({
          where: {
            campaign_id: ref.id,
            is_deleted: 0,
            date: { gte: range.dateStart, lt: range.dateEndExclusive },
            OR: [{ date: yesterdayDate }, { max_cpc: null }],
          },
          data: { max_cpc: Number((bidAccount * task.usdRate).toFixed(4)) },
        });
        stats.statRowsUpdated += updated.count;
      }
    } catch (err) {
      const msg = `MCC ${task.mccId} CID ${task.cid}: ${err instanceof Error ? err.message : String(err)}`;
      stats.errors.push(msg.slice(0, 300));
      log(`采集失败 ${msg}`);
    }
  });

  if (stats.timedOut && offset + stats.cidsDone < tasks.length) {
    stats.nextOffset = offset + stats.cidsDone;
  }

  log(
    `完成(${stats.scope})：MCC ${stats.mccs}、CID ${stats.cidsDone}/${stats.cids}（offset ${offset}）、` +
    `系列出价更新 ${stats.campaignsUpdated}、逐日快照 ${stats.statRowsUpdated} 行、` +
    `跳过无凭据 MCC ${stats.skippedMccs}、错误 ${stats.errors.length}` +
    `${stats.nextOffset != null ? `、软时限收工，续跑 offset=${stats.nextOffset}` : ""}，` +
    `耗时 ${((Date.now() - startedAt) / 1000).toFixed(1)}s`,
  );
  return NextResponse.json({ ok: true, ...stats, elapsedSec: (Date.now() - startedAt) / 1000 });
}
