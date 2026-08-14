import { NextRequest, NextResponse } from "next/server";
import prisma from "@/lib/prisma";
import { queryGoogleAds, microsToDollars, type MccCredentials } from "@/lib/google-ads/client";
import { getAnalysisRange } from "@/lib/campaign-analysis";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

/**
 * D-238 广告分析指标采集（每日 06:10）
 *
 * 为 ads_daily_stats 补齐 kyads 广告分析所需的四个指标，全部走 Google Ads API 直拉
 * （07 拍板：不改各 MCC 的统一 Ads Script，服务端一处改完全员生效）：
 *
 *   1. is_budget / is_rank：campaign 报表 segments.date 逐日值
 *      （search_budget_lost_impression_share / search_rank_lost_impression_share，0-1 分数）
 *   2. quality_score：keyword_view 当前 QS 按当日点击加权（QS 无历史维度，等价于
 *      kyads Ads Script 每天写当天快照的口径）
 *   3. max_cpc：ad_group.cpc_bid_micros 最大值快照（CRM 调价即改 ad_group 出价），
 *      写入窗口内所有空值日 + 昨日
 *
 * 范围：所有配置了活跃 MCC 的用户；窗口 = 最近 7 天（截止昨天）。逐 MCC 串行，
 * 单 MCC 失败只记日志不阻塞其他（jy 组缺 SA 凭据的 MCC 会在此跳过，补配后自动覆盖）。
 *
 * 只 UPDATE 已存在的 ads_daily_stats 行（行由 Sheet 同步产出）；某天该系列没行
 * 说明当天无花费记录，IS 也无分析意义，跳过即可。
 */

function verifyCron(req: NextRequest): boolean {
  const secret = process.env.CRON_SECRET;
  if (!secret) return false;
  return req.headers.get("authorization") === `Bearer ${secret}`;
}

function log(msg: string) {
  console.error(`[CRON ads-metrics-sync ${new Date().toISOString()}] ${msg}`);
}

interface CampaignRef {
  id: bigint;
  google_campaign_id: string;
  customer_id: string;
}

/** 单个 CID 下的一批系列：拉 IS 逐日 + QS 加权 + MaxCpc 快照 */
async function collectCidMetrics(
  credentials: MccCredentials,
  customerId: string,
  campaigns: CampaignRef[],
  range: { startStr: string; endStr: string },
): Promise<{
  isDaily: Map<string, { isBudget: number; isRank: number }>; // key: gcid_date
  qsDaily: Map<string, number>; // key: gcid_date（点击加权）
  maxCpc: Map<string, number>; // key: gcid
}> {
  const gcids = campaigns.map((c) => c.google_campaign_id);
  const gcidList = gcids.join(",");

  const isDaily = new Map<string, { isBudget: number; isRank: number }>();
  const qsDaily = new Map<string, number>();
  const maxCpc = new Map<string, number>();

  // 1) campaign 级 IS 逐日
  const isRows = await queryGoogleAds(credentials, customerId, `
    SELECT campaign.id, segments.date,
      metrics.search_budget_lost_impression_share,
      metrics.search_rank_lost_impression_share
    FROM campaign
    WHERE campaign.id IN (${gcidList})
      AND segments.date BETWEEN '${range.startStr}' AND '${range.endStr}'
  `);
  for (const row of isRows) {
    const campaign = row.campaign as Record<string, unknown> | undefined;
    const segments = row.segments as Record<string, unknown> | undefined;
    const metrics = row.metrics as Record<string, unknown> | undefined;
    const gcid = String(campaign?.id ?? "");
    const date = String(segments?.date ?? "");
    if (!gcid || !date) continue;
    isDaily.set(`${gcid}_${date}`, {
      isBudget: Number(metrics?.searchBudgetLostImpressionShare ?? 0),
      isRank: Number(metrics?.searchRankLostImpressionShare ?? 0),
    });
  }

  // 2) keyword_view：当前 QS + 当日点击（加权用）+ 关键字出价
  const kwRows = await queryGoogleAds(credentials, customerId, `
    SELECT campaign.id, segments.date, metrics.clicks,
      ad_group_criterion.quality_info.quality_score
    FROM keyword_view
    WHERE campaign.id IN (${gcidList})
      AND segments.date BETWEEN '${range.startStr}' AND '${range.endStr}'
      AND ad_group_criterion.status != 'REMOVED'
  `);
  // gcid_date -> [{qs, clicks}]
  const qsAcc = new Map<string, { weighted: number; clicks: number; plain: number; count: number }>();
  for (const row of kwRows) {
    const campaign = row.campaign as Record<string, unknown> | undefined;
    const segments = row.segments as Record<string, unknown> | undefined;
    const metrics = row.metrics as Record<string, unknown> | undefined;
    const criterion = row.adGroupCriterion as Record<string, unknown> | undefined;
    const qualityInfo = criterion?.qualityInfo as Record<string, unknown> | undefined;
    const gcid = String(campaign?.id ?? "");
    const date = String(segments?.date ?? "");
    const qs = Number(qualityInfo?.qualityScore ?? 0);
    const clicks = Number(metrics?.clicks ?? 0);
    if (!gcid || !date || qs <= 0) continue;
    const key = `${gcid}_${date}`;
    const acc = qsAcc.get(key) || { weighted: 0, clicks: 0, plain: 0, count: 0 };
    acc.weighted += qs * clicks;
    acc.clicks += clicks;
    acc.plain += qs;
    acc.count += 1;
    qsAcc.set(key, acc);
  }
  for (const [key, acc] of qsAcc) {
    // 当日有点击按点击加权，无点击退化为简单平均
    const value = acc.clicks > 0 ? acc.weighted / acc.clicks : acc.plain / acc.count;
    qsDaily.set(key, Math.round(value * 10) / 10);
  }

  // 3) ad_group 出价最大值快照（CRM 的「最高出价」语义即 ad_group cpc_bid）
  const agRows = await queryGoogleAds(credentials, customerId, `
    SELECT campaign.id, ad_group.cpc_bid_micros
    FROM ad_group
    WHERE campaign.id IN (${gcidList})
      AND ad_group.status != 'REMOVED'
  `);
  for (const row of agRows) {
    const campaign = row.campaign as Record<string, unknown> | undefined;
    const adGroup = row.adGroup as Record<string, unknown> | undefined;
    const gcid = String(campaign?.id ?? "");
    const bid = microsToDollars(Number(adGroup?.cpcBidMicros ?? 0));
    if (!gcid || bid <= 0) continue;
    if (bid > (maxCpc.get(gcid) || 0)) maxCpc.set(gcid, bid);
  }

  return { isDaily, qsDaily, maxCpc };
}

export async function GET(req: NextRequest) {
  if (!verifyCron(req)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const startedAt = Date.now();
  const range = getAnalysisRange(7);
  const stats = { mccs: 0, cids: 0, updatedRows: 0, skippedMccs: 0, errors: [] as string[] };

  // 活跃 MCC（逐个串行，单个失败不阻塞）
  const mccs = await prisma.google_mcc_accounts.findMany({
    where: { is_deleted: 0 },
    select: {
      id: true, user_id: true, mcc_id: true, mcc_name: true,
      developer_token: true, service_account_json: true,
    },
  });

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
        continue; // 无凭据（jy 组缺 SA），补配后自动覆盖
      }
    }

    // 该 MCC 下窗口内有花费记录的系列（没花费的没有 IS 分析意义）
    const activeCampaignIds = await prisma.ads_daily_stats.findMany({
      where: {
        user_id: mcc.user_id,
        is_deleted: 0,
        date: { gte: range.dateStart, lt: range.dateEndExclusive },
        cost: { gt: 0 },
      },
      select: { campaign_id: true },
      distinct: ["campaign_id"],
    });
    if (activeCampaignIds.length === 0) continue;

    const campaigns = await prisma.campaigns.findMany({
      where: {
        id: { in: activeCampaignIds.map((r) => r.campaign_id) },
        mcc_id: mcc.id,
        is_deleted: 0,
        NOT: [{ google_campaign_id: null }, { google_campaign_id: "" }, { customer_id: null }, { customer_id: "" }],
      },
      select: { id: true, google_campaign_id: true, customer_id: true },
    });
    if (campaigns.length === 0) continue;
    stats.mccs++;

    // 按 CID 分组查询
    const byCid = new Map<string, CampaignRef[]>();
    for (const c of campaigns) {
      const cid = (c.customer_id || "").replace(/-/g, "");
      if (!cid) continue;
      const arr = byCid.get(cid) || [];
      arr.push({ id: c.id, google_campaign_id: c.google_campaign_id!, customer_id: cid });
      byCid.set(cid, arr);
    }

    for (const [cid, refs] of byCid) {
      try {
        stats.cids++;
        const metrics = await collectCidMetrics(credentials, cid, refs, range);

        // 该批系列窗口内的 stats 行，逐行补指标
        const statRows = await prisma.ads_daily_stats.findMany({
          where: {
            campaign_id: { in: refs.map((r) => r.id) },
            is_deleted: 0,
            date: { gte: range.dateStart, lt: range.dateEndExclusive },
          },
          select: { id: true, campaign_id: true, date: true, max_cpc: true },
        });
        const gcidOf = new Map(refs.map((r) => [String(r.id), r.google_campaign_id]));
        const yesterdayStr = range.endStr;

        for (const row of statRows) {
          const gcid = gcidOf.get(String(row.campaign_id));
          if (!gcid) continue;
          const dateStr = row.date.toISOString().slice(0, 10);
          const key = `${gcid}_${dateStr}`;
          const is = metrics.isDaily.get(key);
          const qs = metrics.qsDaily.get(key);
          const bid = metrics.maxCpc.get(gcid);

          const data: Record<string, unknown> = {};
          if (is) { data.is_budget = is.isBudget; data.is_rank = is.isRank; }
          if (qs != null) data.quality_score = qs;
          // MaxCpc 是当前快照：昨日行必写，历史空值行回填（不覆盖历史已写快照）
          if (bid != null && (dateStr === yesterdayStr || row.max_cpc == null)) data.max_cpc = bid;
          if (Object.keys(data).length === 0) continue;

          await prisma.ads_daily_stats.update({ where: { id: row.id }, data });
          stats.updatedRows++;
        }
      } catch (err) {
        const msg = `MCC ${mcc.mcc_id} CID ${cid}: ${err instanceof Error ? err.message : String(err)}`;
        stats.errors.push(msg.slice(0, 300));
        log(`采集失败 ${msg}`);
      }
    }
  }

  log(`完成：MCC ${stats.mccs}、CID ${stats.cids}、更新 ${stats.updatedRows} 行、跳过无凭据 MCC ${stats.skippedMccs}、错误 ${stats.errors.length}，耗时 ${((Date.now() - startedAt) / 1000).toFixed(1)}s`);
  return NextResponse.json({ ok: true, ...stats, elapsedSec: (Date.now() - startedAt) / 1000 });
}
