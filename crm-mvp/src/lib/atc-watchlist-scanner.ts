/**
 * C-089 ATC 广告情报 watchlist 扫描器
 *
 * 每日 cron 调用：扫描全部 active watchlist，对每条调 searchIntelligence，
 * 推送规则（v2，07 二次反馈）：
 *   - 累计天数 ≥ watchlist.min_days（默认 30）
 *   - last_shown 是 CST 昨天（昨天还在投放，今天才提示）
 *   - 同 user × 同 creative × 同 CST 日期 不重复推（日报语义，跨天可再推）
 *
 * 设计文档：设计方案.md C-089 章节
 */

import prisma from "@/lib/prisma";
import { searchIntelligence } from "@/lib/atc-service";
import type { AtcAd, AtcIntelligenceResult } from "@/lib/atc-service";
import { getPoolKeys } from "@/lib/serpapi-key-pool";

export interface WatchlistScanResult {
  scannedUsers: number;
  scannedWatchlists: number;
  skippedNoKey: number;
  skippedSearchError: number;
  /** 新记入 alert_log 的创意条数 */
  alertsCreated: number;
  /** D-218：实际发出的通知条数。合并后一个广告主一轮最多 1 条，通常远小于 alertsCreated */
  notificationsCreated: number;
  elapsedMs: number;
  errors: string[];
}

/** 单条 watchlist 处理结果 */
interface PerItemResult {
  /** 新记入 alert_log 的创意条数 */
  alertsCreated: number;
  /** D-218：实际发出的通知条数（一条 watchlist 最多 1 条） */
  notificationsCreated: number;
  error?: string;
  /** BUG-05 B：本条是否真打了 SerpApi（false=命中本轮共享缓存，调用方据此跳过限流 sleep） */
  calledSerpApi: boolean;
}

/** D-218：一条命中的创意 */
interface CreativeHit {
  creative_id: string;
  days: number;
  domain: string | null;
  domain_source: "meta" | "snapshot" | null;
  /** 首末投放日期，CST */
  first: string;
  last: string;
}

const SLEEP_BETWEEN_CALLS_MS = 1500;

/** 正文里最多逐条列出几条创意，超出折叠成一行 */
const CONTENT_LIST_LIMIT = 10;
/** metadata.creatives 最多存几条，防止 TEXT 列被撑爆 */
const META_CREATIVE_LIMIT = 60;

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * 把 unix 秒转成 CST 时区下的 YYYY-MM-DD 字符串
 * 服务器 process 时区是 UTC，需手动 +8h
 */
function ymdCst(unixSec: number): string {
  const d = new Date(unixSec * 1000);
  d.setUTCHours(d.getUTCHours() + 8);
  return d.toISOString().slice(0, 10);
}

/** 当前时刻按 CST 计算的"昨天"日期字符串 */
function yesterdayCstStr(): string {
  const now = new Date();
  now.setUTCHours(now.getUTCHours() + 8);
  now.setUTCDate(now.getUTCDate() - 1);
  return now.toISOString().slice(0, 10);
}

/** 当前时刻按 CST 计算的"今天"日期字符串（写 alerted_date） */
function todayCstStr(): string {
  const now = new Date();
  now.setUTCHours(now.getUTCHours() + 8);
  return now.toISOString().slice(0, 10);
}

/** "YYYY-MM-DD" 字符串转 Date（按 UTC 0:00 锚定，给 prisma 写 DATE 列用） */
function parseDateStr(ymd: string): Date {
  return new Date(`${ymd}T00:00:00.000Z`);
}

function creativeUrl(advertiserId: string, creativeId: string, region: string): string {
  return `https://adstransparency.google.com/advertiser/${advertiserId}/creative/${creativeId}?region=${region}`;
}

/** D-218：单条命中时维持原标题，多条时汇总，避免同一广告主刷屏 */
function buildTitle(advName: string, hits: CreativeHit[]): string {
  if (hits.length === 1) {
    return `【广告情报】${advName} ${hits[0].days} 天持续广告（昨日还活跃）`;
  }
  return `【广告情报】${advName} ${hits.length} 条持续广告（昨日还活跃，最长 ${hits[0].days} 天）`;
}

function buildContent(hits: CreativeHit[]): string {
  if (hits.length === 1) {
    const h = hits[0];
    return `首次投放 ${h.first}，最近投放 ${h.last}${h.domain ? `；域名 ${h.domain}` : ""}`;
  }
  const lines = hits
    .slice(0, CONTENT_LIST_LIMIT)
    .map((h) => `· ${h.days} 天（${h.first} 起${h.domain ? `，域名 ${h.domain}` : ""}）`);
  if (hits.length > CONTENT_LIST_LIMIT) {
    lines.push(`另有 ${hits.length - CONTENT_LIST_LIMIT} 条未列出。`);
  }
  return [`该广告主昨日仍在投放的长期广告 ${hits.length} 条，按投放时长排序：`, ...lines].join("\n");
}

/**
 * D-218：metadata 同时给两代消费者用。
 * 顶层字段沿用「一条通知 = 一条创意」的老结构，填最长的那条，
 * 这样即便有没排查到的旧消费者，读到的也是合法值而不是 undefined；
 * 新增的 creatives[] 才是本条通知真正覆盖的全部创意，today-ads 按它展开还原计数。
 */
function buildMetadata(advertiserId: string, region: string, hits: CreativeHit[]): string {
  const top = hits[0];
  return JSON.stringify({
    source: "atc_watchlist",
    advertiser_id: advertiserId,
    region,
    creative_id: top.creative_id,
    days: top.days,
    domain: top.domain,
    domain_source: top.domain_source,
    atc_url: creativeUrl(advertiserId, top.creative_id, region),
    creative_count: hits.length,
    creatives: hits.slice(0, META_CREATIVE_LIMIT).map((h) => ({
      creative_id: h.creative_id,
      days: h.days,
      domain: h.domain,
      domain_source: h.domain_source,
    })),
  });
}

/**
 * 对一条 watchlist 跑一遍：调 SerpApi → 比对 alert_log → 新发现写 notification
 */
async function processOneWatchlist(
  watchlist: {
    id: bigint;
    user_id: bigint;
    advertiser_id: string;
    advertiser_name: string | null;
    region: string;
    min_days: number;
  },
  serpApiKeys: string[],
  yesterdayCst: string,
  todayCst: string,
  intelCache: Map<string, AtcIntelligenceResult>,
): Promise<PerItemResult> {
  let calledSerpApi = false;
  try {
    // BUG-05 B：跨用户共享缓存——同一 (advertiser_id, region) 当轮只真打一次 SerpApi。
    // advertiser_id 查询的结果只取决于广告主本身，与用户/key 无关，可安全跨用户复用。
    const cacheKey = `${watchlist.advertiser_id}|${watchlist.region}`;
    let result = intelCache.get(cacheKey);
    if (!result) {
      result = await searchIntelligence({
        advertiser_id: watchlist.advertiser_id,
        region: watchlist.region,
        serpApiKeys,
      });
      calledSerpApi = true;
      intelCache.set(cacheKey, result); // 仅成功结果入缓存（失败会 throw，不污染缓存）
    }

    const adv = result.advertisers.find((a) => a.id === watchlist.advertiser_id);
    if (!adv || !Array.isArray(adv.ads) || adv.ads.length === 0) {
      return { alertsCreated: 0, notificationsCreated: 0, calledSerpApi };
    }

    // D-008 F-17=C：scanner 写库前从 atc_advertiser_domain_snapshot 拿 fallback domain 列表
    // SerpApi advertiser_id 查询不返回 target_domain，导致 ad.domain 大量空（实测 38.74%）；
    // snapshot 表是团队共享缓存（按 advertiser_id+region 全局唯一），命中率高且不消耗额外 SerpApi quota。
    type DomainStat = { domain: string; creative_count?: number; has_long_running_creative?: boolean };
    let snapshotFallbackDomain: string | null = null;
    try {
      const snap = await prisma.atc_advertiser_domain_snapshot.findUnique({
        where: { advertiser_id_region: { advertiser_id: watchlist.advertiser_id, region: watchlist.region } },
        select: { domains_json: true },
      });
      const list = Array.isArray(snap?.domains_json) ? (snap!.domains_json as DomainStat[]) : [];
      const sorted = list
        .filter((d) => d && typeof d.domain === "string" && d.domain.length > 0)
        .sort((a, b) => {
          const aQ = a.has_long_running_creative ? 1 : 0;
          const bQ = b.has_long_running_creative ? 1 : 0;
          if (aQ !== bQ) return bQ - aQ;
          return (b.creative_count ?? 0) - (a.creative_count ?? 0);
        });
      snapshotFallbackDomain = sorted[0]?.domain.toLowerCase() ?? null;
    } catch {
      // snapshot 拉取失败不影响主流程，仅丢 fallback 能力
    }

    // 该用户今天已经推过的 creative_id 集合（同 user × 同 creative × 同日期不重复推）
    const todayDate = parseDateStr(todayCst);
    const alreadyAlertedToday = await prisma.user_atc_alert_log.findMany({
      where: { user_id: watchlist.user_id, alerted_date: todayDate },
      select: { creative_id: true },
    });
    const alertedTodaySet = new Set(alreadyAlertedToday.map((r) => r.creative_id));

    // D-218：先把本轮命中的创意攒起来，最后合并成一条通知。
    // 原先一条创意发一条通知，PATRONUM 这类长期投放的广告主一天能给同一个人刷 12 条，
    // 标题之间只有天数不同（8/5 全天 234 条 ATC 通知里它一家占 153 条）。
    // 审计仍按创意粒度写 user_atc_alert_log，防重规则一并保持不变，只合并通知本身。
    const hits: CreativeHit[] = [];

    for (const ad of adv.ads as AtcAd[]) {
      if (!ad.creative_id) continue;
      if (!ad.first_shown || !ad.last_shown) continue;

      // 规则 1：累计天数 ≥ min_days
      const days = Math.round((ad.last_shown - ad.first_shown) / 86400);
      if (days < watchlist.min_days) continue;

      // 规则 2：last_shown 必须是 CST 昨天（昨天还在投放）
      if (ymdCst(ad.last_shown) !== yesterdayCst) continue;

      // 规则 3：今天已推过该 creative → 跳过（同日防重）
      if (alertedTodaySet.has(ad.creative_id)) continue;

      // D-008 F-17=C：domain 优先 ad.domain，其次 snapshot fallback；标 source 让下游知道来源
      const finalDomain = ad.domain ?? snapshotFallbackDomain ?? null;
      hits.push({
        creative_id: ad.creative_id,
        days,
        domain: finalDomain,
        domain_source: ad.domain ? "meta" : snapshotFallbackDomain ? "snapshot" : null,
        first: ymdCst(ad.first_shown),
        last: ymdCst(ad.last_shown),
      });
      alertedTodaySet.add(ad.creative_id);
    }

    if (hits.length === 0) return { alertsCreated: 0, notificationsCreated: 0, calledSerpApi };

    // 标题/正文/metadata 都按「最长的那条创意」打头，先排好序
    hits.sort((a, b) => b.days - a.days);
    const advName = adv.name || watchlist.advertiser_name || watchlist.advertiser_id;

    let logged = 0;
    await prisma.$transaction(async (tx) => {
      // skipDuplicates 兜的是并发：上面 alertedTodaySet 已过滤掉今天推过的，
      // 只有同一轮 cron 被重复触发才可能撞 uk_user_creative_date。
      const res = await tx.user_atc_alert_log.createMany({
        data: hits.map((h) => ({
          user_id: watchlist.user_id,
          watchlist_id: watchlist.id,
          advertiser_id: watchlist.advertiser_id,
          creative_id: h.creative_id,
          days: h.days,
          domain: h.domain,
          alerted_date: todayDate,
        })),
        skipDuplicates: true,
      });
      // 整批都撞重 = 这些创意已经推送过，不再打扰
      if (res.count === 0) return;
      await tx.notifications.create({
        data: {
          user_id: watchlist.user_id,
          type: "ad",
          title: buildTitle(advName, hits),
          content: buildContent(hits),
          metadata: buildMetadata(watchlist.advertiser_id, watchlist.region, hits),
        },
      });
      logged = res.count;
    });

    return {
      alertsCreated: logged,
      notificationsCreated: logged > 0 ? 1 : 0,
      calledSerpApi,
    };
  } catch (err) {
    return {
      alertsCreated: 0,
      notificationsCreated: 0,
      error: err instanceof Error ? err.message : String(err),
      calledSerpApi,
    };
  }
}

/**
 * 主入口：扫描全部 watchlist
 */
export async function scanAllWatchlists(): Promise<WatchlistScanResult> {
  const startedAt = Date.now();
  const res: WatchlistScanResult = {
    scannedUsers: 0,
    scannedWatchlists: 0,
    skippedNoKey: 0,
    skippedSearchError: 0,
    alertsCreated: 0,
    notificationsCreated: 0,
    elapsedMs: 0,
    errors: [],
  };

  const watchlists = await prisma.user_atc_watchlist.findMany({
    where: { is_deleted: 0 },
    orderBy: [{ user_id: "asc" }, { id: "asc" }],
  });
  res.scannedWatchlists = watchlists.length;
  if (watchlists.length === 0) {
    res.elapsedMs = Date.now() - startedAt;
    return res;
  }

  // 整轮共享的 CST 昨天 / 今天 字符串
  const yesterdayCst = yesterdayCstStr();
  const todayCst = todayCstStr();

  // BUG-05 B：本轮跨用户共享的情报结果缓存（key=advertiser_id|region）。
  // 多个用户盯同一广告主时，当轮只真打一次 SerpApi，其余命中缓存，省 SerpApi 额度。
  const intelCache = new Map<string, AtcIntelligenceResult>();

  // 按 user_id 分组，一次加载该用户的 SerpApi key 池
  const byUser = new Map<string, typeof watchlists>();
  for (const w of watchlists) {
    const k = w.user_id.toString();
    if (!byUser.has(k)) byUser.set(k, []);
    byUser.get(k)!.push(w);
  }
  res.scannedUsers = byUser.size;

  // D-215：key 改成全局共享池。以前按 user_id 取，某人额度打满他关注的广告主当天就全废，
  // 别人富余的额度也调不动；现在谁的 key 都能用，撞额度时 callSerpApi 内部自动换下一个。
  const serpApiKeys = await getPoolKeys();
  if (serpApiKeys.length === 0) {
    res.skippedNoKey += watchlists.length;
    res.elapsedMs = Date.now() - startedAt;
    return res;
  }

  for (const [, userWatches] of byUser) {
    for (const w of userWatches) {
      const item = await processOneWatchlist(w, serpApiKeys, yesterdayCst, todayCst, intelCache);
      res.alertsCreated += item.alertsCreated;
      res.notificationsCreated += item.notificationsCreated;
      if (item.error) {
        res.skippedSearchError++;
        res.errors.push(`watchlist#${w.id}(${w.advertiser_id}): ${item.error.slice(0, 200)}`);
      }
      // BUG-05 B：命中本轮缓存（未真打 SerpApi）时无需限流等待，加速整轮扫描
      if (item.calledSerpApi) await sleep(SLEEP_BETWEEN_CALLS_MS);
    }
  }

  res.elapsedMs = Date.now() - startedAt;
  return res;
}
