/**
 * C-089 ATC 广告情报 watchlist 扫描器
 *
 * 每日 cron 调用：扫描全部 active watchlist，对每条调 searchIntelligence，
 * 找出新出现的「持续投放 ≥ min_days」的 creative，写入 notifications（type='ad'）
 * 并记录到 user_atc_alert_log（按 user_id + creative_id 全局唯一防重）。
 *
 * 设计文档：设计方案.md C-089 章节 Phase 2
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
): Promise<PerItemResult> {
  try {
    const result = await searchIntelligence({
      advertiser_id: watchlist.advertiser_id,
      region: watchlist.region,
      serpApiKeys,
    });

    // searchIntelligence 返回的 advertisers 数组里找匹配 advertiser_id 那一条
    const adv = result.advertisers.find((a) => a.id === watchlist.advertiser_id);
    if (!adv || !Array.isArray(adv.ads) || adv.ads.length === 0) {
      return { alertsCreated: 0 };
    }

    // 该用户已推过的 creative_id 集合
    const alreadyAlerted = await prisma.user_atc_alert_log.findMany({
      where: { user_id: watchlist.user_id },
      select: { creative_id: true },
    });
    const alertedSet = new Set(alreadyAlerted.map((r) => r.creative_id));

    let alertsCreated = 0;

    for (const ad of adv.ads as AtcAd[]) {
      if (!ad.creative_id) continue;
      if (!ad.first_shown || !ad.last_shown) continue;
      const days = Math.round((ad.last_shown - ad.first_shown) / 86400);
      if (days < watchlist.min_days) continue;
      if (alertedSet.has(ad.creative_id)) continue;

      // 拼装 ATC 创意详情页 URL（07 之前已验证格式）
      const atcUrl = `https://adstransparency.google.com/advertiser/${watchlist.advertiser_id}/creative/${ad.creative_id}?region=${watchlist.region}`;
      const advName = adv.name || watchlist.advertiser_name || watchlist.advertiser_id;
      const domainPart = ad.domain ? `；域名 ${ad.domain}` : "";
      const firstStr = new Date(ad.first_shown * 1000).toISOString().slice(0, 10);
      const lastStr = new Date(ad.last_shown * 1000).toISOString().slice(0, 10);

      // 串行 transaction：先写 alert_log（uk_user_creative 防并发重复），再写 notification
      try {
        await prisma.$transaction(async (tx) => {
          await tx.user_atc_alert_log.create({
            data: {
              user_id: watchlist.user_id,
              watchlist_id: watchlist.id,
              advertiser_id: watchlist.advertiser_id,
              creative_id: ad.creative_id!,
              days,
            },
          });
          await tx.notifications.create({
            data: {
              user_id: watchlist.user_id,
              type: "ad",
              title: `【广告情报】${advName} 新增持续投放 ${days} 天的广告`,
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
        alertedSet.add(ad.creative_id);
      } catch (err) {
        // alert_log 唯一约束冲突（并发跑两次扫描）属正常，吞掉
        const msg = err instanceof Error ? err.message : String(err);
        if (!msg.includes("uk_user_creative") && !msg.includes("Duplicate entry")) {
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
      const item = await processOneWatchlist(w, serpApiKeys);
      res.alertsCreated += item.alertsCreated;
      if (item.error) {
        res.skippedSearchError++;
        res.errors.push(`watchlist#${w.id}(${w.advertiser_id}): ${item.error.slice(0, 200)}`);
      }
      // SerpApi 间留点间隔，避免 rate limit
      await sleep(SLEEP_BETWEEN_CALLS_MS);
    }
  }

  res.elapsedMs = Date.now() - startedAt;
  return res;
}
