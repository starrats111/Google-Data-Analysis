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
import type { AtcAd } from "@/lib/atc-service";

export interface WatchlistScanResult {
  scannedUsers: number;
  scannedWatchlists: number;
  skippedNoKey: number;
  skippedSearchError: number;
  alertsCreated: number;
  elapsedMs: number;
  errors: string[];
}

/** 单条 watchlist 处理结果 */
interface PerItemResult {
  alertsCreated: number;
  error?: string;
}

const SLEEP_BETWEEN_CALLS_MS = 1500;

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
): Promise<PerItemResult> {
  try {
    const result = await searchIntelligence({
      advertiser_id: watchlist.advertiser_id,
      region: watchlist.region,
      serpApiKeys,
    });

    const adv = result.advertisers.find((a) => a.id === watchlist.advertiser_id);
    if (!adv || !Array.isArray(adv.ads) || adv.ads.length === 0) {
      return { alertsCreated: 0 };
    }

    // 该用户今天已经推过的 creative_id 集合（同 user × 同 creative × 同日期不重复推）
    const todayDate = parseDateStr(todayCst);
    const alreadyAlertedToday = await prisma.user_atc_alert_log.findMany({
      where: { user_id: watchlist.user_id, alerted_date: todayDate },
      select: { creative_id: true },
    });
    const alertedTodaySet = new Set(alreadyAlertedToday.map((r) => r.creative_id));

    let alertsCreated = 0;

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

      const atcUrl = `https://adstransparency.google.com/advertiser/${watchlist.advertiser_id}/creative/${ad.creative_id}?region=${watchlist.region}`;
      const advName = adv.name || watchlist.advertiser_name || watchlist.advertiser_id;
      const domainPart = ad.domain ? `；域名 ${ad.domain}` : "";
      const firstStr = ymdCst(ad.first_shown);
      const lastStr = ymdCst(ad.last_shown);

      try {
        await prisma.$transaction(async (tx) => {
          await tx.user_atc_alert_log.create({
            data: {
              user_id: watchlist.user_id,
              watchlist_id: watchlist.id,
              advertiser_id: watchlist.advertiser_id,
              creative_id: ad.creative_id!,
              days,
              alerted_date: todayDate,
            },
          });
          await tx.notifications.create({
            data: {
              user_id: watchlist.user_id,
              type: "ad",
              title: `【广告情报】${advName} ${days} 天持续广告（昨日还活跃）`,
              content: `首次投放 ${firstStr}，最近投放 ${lastStr}${domainPart}`,
              metadata: JSON.stringify({
                source: "atc_watchlist",
                advertiser_id: watchlist.advertiser_id,
                creative_id: ad.creative_id,
                region: watchlist.region,
                days,
                domain: ad.domain ?? null,
                atc_url: atcUrl,
              }),
            },
          });
        });
        alertsCreated++;
        alertedTodaySet.add(ad.creative_id);
      } catch (err) {
        // uk_user_creative_date 冲突（同一天多次跑 scan）属正常，吞掉
        const msg = err instanceof Error ? err.message : String(err);
        if (!msg.includes("uk_user_creative_date") && !msg.includes("Duplicate entry")) {
          throw err;
        }
      }
    }

    return { alertsCreated };
  } catch (err) {
    return {
      alertsCreated: 0,
      error: err instanceof Error ? err.message : String(err),
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

  // 按 user_id 分组，一次加载该用户的 SerpApi key 池
  const byUser = new Map<string, typeof watchlists>();
  for (const w of watchlists) {
    const k = w.user_id.toString();
    if (!byUser.has(k)) byUser.set(k, []);
    byUser.get(k)!.push(w);
  }
  res.scannedUsers = byUser.size;

  for (const [userIdStr, userWatches] of byUser) {
    const userId = BigInt(userIdStr);

    const keyRows = await prisma.user_serpapi_keys.findMany({
      where: { user_id: userId, is_active: 1, is_deleted: 0 },
      select: { api_key: true },
    });
    const serpApiKeys = keyRows.map((r) => r.api_key).filter((k) => k && k.trim());
    if (serpApiKeys.length === 0) {
      res.skippedNoKey += userWatches.length;
      continue;
    }

    for (const w of userWatches) {
      const item = await processOneWatchlist(w, serpApiKeys, yesterdayCst, todayCst);
      res.alertsCreated += item.alertsCreated;
      if (item.error) {
        res.skippedSearchError++;
        res.errors.push(`watchlist#${w.id}(${w.advertiser_id}): ${item.error.slice(0, 200)}`);
      }
      await sleep(SLEEP_BETWEEN_CALLS_MS);
    }
  }

  res.elapsedMs = Date.now() - startedAt;
  return res;
}
