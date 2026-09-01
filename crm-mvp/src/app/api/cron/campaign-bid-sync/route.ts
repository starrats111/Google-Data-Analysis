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
 *   1. 采集读错字段。绝大多数在投系列是 MAXIMIZE_CLICKS（GAQL 里 biddingStrategyType
 *      = TARGET_SPEND），自动出价下 ad_group 出价是建广告时留下的僵尸值，Google 出价时
 *      根本不看。真值在 campaign.target_spend.cpc_bid_ceiling_micros。
 *      ⚠️ campaigns.bidding_strategy 这一列不可信（库里一律记着 MAXIMIZE_CLICKS，
 *      实测有 75 条在 Google 上其实是 MANUAL_CPC），策略必须问 Google。
 *   2. 采集被 Sheet 闸门带停。D-264 起「Sheet 有 ISBudget 列就跳过整个 MCC」，而统一
 *      脚本的 Sheet 有 IS/QS 列、没有出价列，于是 8-25 起 21 个 MCC 的 max_cpc 全线断供。
 *
 * 出价采集因此从 ads-metrics-sync 里单拎出来：供数来源是 API，与 IS/QS 走 Sheet 无关，
 * 不该共用一个跳过条件。本 cron 覆盖所有有凭据的 MCC。
 *
 * 写两处：
 *   · campaigns.max_cpc_limit ← **此刻**的上限，账户币种原值（该列口径即账户币种，D-266 批一）
 *   · ads_daily_stats.max_cpc ← **那一天**的上限，折美元（该列口径是 USD）
 *
 * D-304.1：逐日快照必须是「那天实际是多少」，不能拿今天的值去糊历史。
 * 实例：wj11 的 674-LB1 在后台被逐日调价——8/25→$4.00、8/26→$4.20、8/27→$4.60、
 * 今早→$5.20。第一版把 $5.20 刷满了 8/26~8/31 六天，等于把调价过程抹平成一条直线，
 * 之后拿这些数做 ROI 复盘会得出完全错的结论。
 * 现在走 change_event 还原：以「此刻的值」为锚点往回倒推——晚于某日的第一次变更，
 * 它的 old 值就是那天收盘时的上限；该日之后没变过就还是此刻的值。这样今天天然正确，
 * 历史也不会被今天污染。拿不到变更历史时整段不写，宁可留空。
 *
 * D-304.2（逐人抽查 13 个投手后补的三个洞）：
 *   a. 口径漏人：原先只扫「ENABLED 或窗口内有花费」，把「已暂停且零花费、但窗口内
 *      有行」的 217 条系列漏在外面——它们的弹窗永远是空的。改为
 *      **ENABLED ∪ 窗口内有行**（625 个 CID，与原口径几乎同量）。
 *   b. 旧脏值不清：某天 Google 上本就没有出价上限时，原先「跳过不写」，于是老 cron
 *      从 ad_group 读来的脏值（如 ¥0.01→$0.0015）一直挂着。改为写 NULL——
 *      「没有上限」就该显示空，不能拿一个假数字顶着。
 *   c. MANUAL_CPC 无快照：这类系列出价在 ad_group 上，改为按广告组各自还原历史、
 *      逐日取最大值，与自动出价系列一视同仁。
 *
 * ⚠️ 不碰 last_google_sync_at：那一列的语义是「状态最后一次跟 Google 核对过」，
 * campaign-status-drift 靠它判断「已暂停却还在花钱」。本 cron 不读状态，碰它等于伪造证词。
 *
 * 参数：?offset=N —— 从 CID 工作队列的第 N 个开始；触发软时限时返回 nextOffset 供续跑。
 */

function verifyCron(req: NextRequest): boolean {
  const secret = process.env.CRON_SECRET;
  if (!secret) return false;
  return req.headers.get("authorization") === `Bearer ${secret}`;
}

function log(msg: string) {
  console.error(`[CRON campaign-bid-sync ${new Date().toISOString()}] ${msg}`);
}

/** CID 间并发度：625 个 CID 串行要跑十分钟以上，远超单次 cron 预算 */
const CID_CONCURRENCY = 6;
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
 * 一条出价的时间序列：此刻的值 + 窗口内的变更（升序）。
 * before 是那次变更**之前**的值（null = 那之前没有出价/上限）。
 */
interface BidSeries {
  current: number | null;
  changes: Array<{ date: string; before: number | null }>;
}

interface CampaignBid {
  strategy: string;
  /** 自动出价：系列级一条序列。MANUAL_CPC：每个广告组一条，逐日取最大值。 */
  series: Map<string, BidSeries>;
}

/**
 * 自动出价策略里出价上限所在的字段容器（与 mutate.ts 的 CEILING_CONTAINER 同一套口径）。
 * MANUAL_CPC 的出价在 ad_group 上，不在这里；MAXIMIZE_CONVERSIONS 之类没有上限概念。
 */
const CEILING_SELECT = [
  "campaign.target_spend.cpc_bid_ceiling_micros",
  "campaign.percent_cpc.cpc_bid_ceiling_micros",
].join(", ");

/** 从 campaign 对象里取出价上限（账户币种）；没设上限返回 null */
function readCeiling(campaign: Record<string, unknown> | undefined): number | null {
  for (const container of [campaign?.targetSpend, campaign?.percentCpc]) {
    const micros = Number((container as Record<string, unknown> | undefined)?.cpcBidCeilingMicros ?? 0);
    if (micros > 0) return microsToDollars(micros);
  }
  return null;
}

/** 从 old_resource / new_resource 里取 campaign 级上限 */
function ceilingOfResource(resource: unknown): number | null {
  const campaign = (resource as Record<string, unknown> | undefined)?.campaign;
  return readCeiling(campaign as Record<string, unknown> | undefined);
}

/** 从 old_resource / new_resource 里取 ad_group 出价 */
function adGroupBidOfResource(resource: unknown): number | null {
  const ag = (resource as Record<string, unknown> | undefined)?.adGroup as Record<string, unknown> | undefined;
  const micros = Number(ag?.cpcBidMicros ?? 0);
  return micros > 0 ? microsToDollars(micros) : null;
}

/** 某条序列在「那天结束时」的值：晚于该日的第一次变更，它的 before 就是当天收盘值 */
function seriesOnDate(s: BidSeries, dateStr: string): number | null {
  for (const ch of s.changes) {       // changes 已按时间升序
    if (ch.date > dateStr) return ch.before;
  }
  return s.current;
}

/** 一条系列在某天的出价（MANUAL_CPC 取各广告组的最大值）；全为空返回 null */
function bidOnDate(bid: CampaignBid, dateStr: string): number | null {
  let max: number | null = null;
  for (const s of bid.series.values()) {
    const v = seriesOnDate(s, dateStr);
    if (v != null && (max == null || v > max)) max = v;
  }
  return max;
}

/** 此刻的出价（同上，取当前值） */
function bidNow(bid: CampaignBid): number | null {
  let max: number | null = null;
  for (const s of bid.series.values()) {
    if (s.current != null && (max == null || s.current > max)) max = s.current;
  }
  return max;
}

/**
 * 一个 CID 下这批系列的出价 + 窗口内的变更历史。
 * 三次查询：系列当前上限 → （若有 MANUAL_CPC）广告组当前出价 → 整个 CID 的变更流水。
 */
async function collectCidBids(
  task: CidTask,
  range: { startStr: string; afterEndStr: string },
): Promise<Map<string, CampaignBid>> {
  const out = new Map<string, CampaignBid>();
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
    const strategy = String(campaign?.biddingStrategyType ?? "");
    const bid: CampaignBid = { strategy, series: new Map() };
    if (strategy === "MANUAL_CPC") {
      manualGcids.push(gcid);          // 出价在广告组上，下一步查
    } else {
      // 上限未设置（Google 不返回该字段）就是「没有上限」，写 0 会把它伪装成 $0 出价
      bid.series.set("campaign", { current: readCeiling(campaign), changes: [] });
    }
    out.set(gcid, bid);
  }

  // 广告组资源名 → 所属系列，供变更流水归位
  const agOwner = new Map<string, string>();
  if (manualGcids.length > 0) {
    const agRows = await queryGoogleAds(task.credentials, task.cid, `
      SELECT campaign.id, ad_group.resource_name, ad_group.cpc_bid_micros
      FROM ad_group
      WHERE campaign.id IN (${manualGcids.join(",")})
        AND ad_group.status != 'REMOVED'
    `);
    for (const row of agRows) {
      const campaign = row.campaign as Record<string, unknown> | undefined;
      const adGroup = row.adGroup as Record<string, unknown> | undefined;
      const gcid = String(campaign?.id ?? "");
      const rn = String(adGroup?.resourceName ?? adGroup?.resource_name ?? "");
      const bid = out.get(gcid);
      if (!bid || !rn) continue;
      const micros = Number(adGroup?.cpcBidMicros ?? 0);
      bid.series.set(rn, { current: micros > 0 ? microsToDollars(micros) : null, changes: [] });
      agOwner.set(rn, gcid);
    }
  }

  if (out.size === 0) return out;

  // ⚠️ 必须滤掉 GOOGLE_ADS_SCRIPTS：换链脚本每隔几分钟改一次 finalUrlSuffix，
  //    单条系列一个月就能刷出上万条，把出价变更整个淹掉（LIMIT 上限 10000）。
  //    代价：万一哪天有 Ads Script 去改出价，这里看不见——目前脚本只管换链，不碰出价。
  const evRows = await queryGoogleAds(task.credentials, task.cid, `
    SELECT change_event.change_date_time, change_event.campaign, change_event.ad_group,
      change_event.old_resource, change_event.new_resource
    FROM change_event
    WHERE change_event.change_date_time >= '${range.startStr}'
      AND change_event.change_date_time <= '${range.afterEndStr}'
      AND change_event.change_resource_type IN ('CAMPAIGN', 'AD_GROUP')
      AND change_event.client_type != 'GOOGLE_ADS_SCRIPTS'
    ORDER BY change_event.change_date_time ASC
    LIMIT 10000
  `);
  for (const row of evRows) {
    const ev = row.changeEvent as Record<string, unknown> | undefined;
    const dt = String(ev?.changeDateTime ?? "");
    if (dt.length < 10) continue;
    const date = dt.slice(0, 10);

    // 广告组出价变更
    const agRn = String(ev?.adGroup ?? "");
    if (agRn && agOwner.has(agRn)) {
      const before = adGroupBidOfResource(ev?.oldResource);
      const after = adGroupBidOfResource(ev?.newResource);
      if (before != null || after != null) {
        out.get(agOwner.get(agRn)!)?.series.get(agRn)?.changes.push({ date, before });
        continue;
      }
    }
    // 系列级上限变更
    const gcid = String(ev?.campaign ?? "").split("/").pop() || "";
    const series = out.get(gcid)?.series.get("campaign");
    if (!series) continue;
    const before = ceilingOfResource(ev?.oldResource);
    const after = ceilingOfResource(ev?.newResource);
    // 两边都没有上限字段 = 这条变更跟出价无关（改的是状态/文案/预算等），跳过
    if (before == null && after == null) continue;
    series.changes.push({ date, before });
  }

  return out;
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
  const offset = Math.max(0, Number(req.nextUrl.searchParams.get("offset") || 0) || 0);

  const range = getAnalysisRange(7);
  const { getExchangeRate } = await import("@/lib/exchange-rate");
  const { todayCST, dateColumnStart } = await import("@/lib/date-utils");
  const todayForRate = todayCST();

  // 窗口内的每一天（YYYY-MM-DD，账户时区口径与 segments.date 一致）
  const windowDates: string[] = [];
  for (let d = dateColumnStart(range.startStr); d < range.dateEndExclusive; d.setUTCDate(d.getUTCDate() + 1)) {
    windowDates.push(d.toISOString().slice(0, 10));
  }
  // change_event 的上界要含「今天」——昨天收盘时的值，取决于今天有没有再改过
  const tomorrow = dateColumnStart(todayForRate);
  tomorrow.setUTCDate(tomorrow.getUTCDate() + 1);
  const tomorrowStr = tomorrow.toISOString().slice(0, 10);

  const stats = {
    offset,
    mccs: 0, cids: 0, cidsDone: 0, campaignsUpdated: 0,
    statRowsUpdated: 0, statRowsCleared: 0,
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

    // D-304.2a：口径 = 窗口内有行（弹窗要用）∪ ENABLED（看板要用）。
    // 不能再按「有花费」筛——已暂停且零花费的系列照样有行、照样会被点开看。
    const rowCampaigns = await prisma.ads_daily_stats.findMany({
      where: {
        user_id: mcc.user_id,
        is_deleted: 0,
        date: { gte: range.dateStart, lt: range.dateEndExclusive },
      },
      select: { campaign_id: true },
      distinct: ["campaign_id"],
    });
    const rowIds = rowCampaigns.map((r) => r.campaign_id);

    const campaigns = await prisma.campaigns.findMany({
      where: {
        mcc_id: mcc.id,
        is_deleted: 0,
        NOT: [{ google_campaign_id: null }, { google_campaign_id: "" }, { customer_id: null }, { customer_id: "" }],
        OR: [{ google_status: "ENABLED" }, { id: { in: rowIds } }],
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
      const bids = await collectCidBids(task, { startStr: range.startStr, afterEndStr: tomorrowStr });
      if (bids.size === 0) return;

      for (const ref of task.refs) {
        const bid = bids.get(ref.google_campaign_id);
        if (!bid) continue;

        // 1) 系列上的「现在的出价」：账户币种原值，变了才写
        const now = bidNow(bid);
        if (now != null) {
          const accountValue = Number(now.toFixed(4));
          if (Number(ref.max_cpc_limit ?? -1) !== accountValue) {
            await prisma.campaigns.update({
              where: { id: ref.id },
              data: { max_cpc_limit: accountValue },
            });
            stats.campaignsUpdated++;
          }
        }

        // 2) 逐日快照：每天写**那天**的真值。拿不到变更历史就整段不写——
        //    宁可留空，也不能再拿今天的值去糊历史（D-304.1 病根）。
        //    变更流水拉不到会直接抛错走 catch，整个 CID 不写，不会写出半真半假的快照。
        if (task.usdRate <= 0) continue;

        // 同值的日期合并成一条 updateMany；值为 null 的那批要清空旧脏值（D-304.2b）
        const datesByValue = new Map<number, Date[]>();
        const datesToClear: Date[] = [];
        for (const dateStr of windowDates) {
          const account = bidOnDate(bid, dateStr);
          const dateObj = dateColumnStart(dateStr);
          if (account == null) { datesToClear.push(dateObj); continue; }
          const usd = Number((account * task.usdRate).toFixed(4));
          const arr = datesByValue.get(usd) || [];
          arr.push(dateObj);
          datesByValue.set(usd, arr);
        }
        for (const [usd, dates] of datesByValue) {
          const updated = await prisma.ads_daily_stats.updateMany({
            where: { campaign_id: ref.id, is_deleted: 0, date: { in: dates }, NOT: { max_cpc: usd } },
            data: { max_cpc: usd },
          });
          stats.statRowsUpdated += updated.count;
        }
        if (datesToClear.length > 0) {
          // 那天 Google 上就没有出价上限：显示空才是实话，不能留着老 cron 从
          // ad_group 读来的脏值（实测有 ¥0.01 折成 $0.0015 一直挂着的）
          const cleared = await prisma.ads_daily_stats.updateMany({
            where: { campaign_id: ref.id, is_deleted: 0, date: { in: datesToClear }, NOT: { max_cpc: null } },
            data: { max_cpc: null },
          });
          stats.statRowsCleared += cleared.count;
        }
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
    `完成：MCC ${stats.mccs}、CID ${stats.cidsDone}/${stats.cids}（offset ${offset}）、` +
    `系列出价更新 ${stats.campaignsUpdated}、逐日快照写入 ${stats.statRowsUpdated} 行、` +
    `清空旧脏值 ${stats.statRowsCleared} 行、跳过无凭据 MCC ${stats.skippedMccs}、` +
    `错误 ${stats.errors.length}` +
    `${stats.nextOffset != null ? `、软时限收工，续跑 offset=${stats.nextOffset}` : ""}，` +
    `耗时 ${((Date.now() - startedAt) / 1000).toFixed(1)}s`,
  );
  return NextResponse.json({ ok: true, ...stats, elapsedSec: (Date.now() - startedAt) / 1000 });
}
