/**
 * D-213 ATC 追踪广告主 → 推荐商家 每日同步
 *
 * 徐克的要求是「推荐列表除官方给的，每天要定时获取别人已经在跑 2 周以上的商家」。
 * 每日 cron atc-watchlist-scan 一直在产出这批数据，但此前只落进通知里，没进推荐表。
 *
 * 这里做三件事：
 *   1. 从 user_atc_alert_log 聚合出「同行投够天数、近期还在投」的域名
 *   2. 拿域名反查 user_merchants.merchant_url，取回真实商家名与联盟平台
 *      —— 反查不到的直接丢弃，绝不拿域名硬凑商家名（见 data-integrity 规范）
 *   3. 全量重算 source='atc' 那批：还在投的更新天数，不再出现的软删下架
 *
 * 只动 source='atc' 的记录，官方的 sheets / excel 两批完全不碰。
 * 商家名若已在官方名单里则跳过，避免推荐列表同一个商家出现两行。
 */
import prisma from "@/lib/prisma";

/** 同行至少投够多少天才收录。07 于 2026-08-05 复核后取 15（徐克原话「2 周以上」= ≥14） */
const MIN_DAYS = Number(process.env.ATC_REC_MIN_DAYS ?? 15);

/**
 * 多少天内被扫到过就算「还在投」。
 * 不能取 1 天：SerpApi 额度绑在各用户身上，关注的 36 个广告主每天只有 8 个左右能扫出数据，
 * 窗口太窄会把「今天没轮到扫」误判成「同行停投了」，导致商家天天上下架。
 */
const ACTIVE_WINDOW_DAYS = Number(process.env.ATC_REC_ACTIVE_DAYS ?? 14);

export interface AtcRecSyncOptions {
  /** 只算不写。首次上线和排障时先用它核对数字，确认无误再真跑 */
  dryRun?: boolean;
}

export interface AtcRecSyncResult {
  dry_run: boolean;
  /** alert_log 里投够天数且窗口内还在投的唯一域名数 */
  scanned_domains: number;
  /** 其中反查到真实商家名的 */
  matched: number;
  /** 反查不到商家名、已丢弃的 */
  unmatched: number;
  /** 商家已在官方名单里、跳过不重复收录的 */
  skipped_official: number;
  created: number;
  updated: number;
  /** 同行已停投、本轮软删下架的 */
  retired: number;
  batch: string;
}

/** 把任意 URL/裸 domain 归一为不带协议、不带 www、小写的 domain */
function normalizeDomain(raw: string | null | undefined): string {
  if (!raw) return "";
  let s = raw.trim().toLowerCase();
  s = s.replace(/^https?:\/\//, "");
  s = s.replace(/^www\./, "");
  s = s.split("/")[0];
  s = s.split("?")[0];
  s = s.split(":")[0];
  return s;
}

/** 拿一批域名去 user_merchants 反查商家名与平台（归一化后精确匹配） */
async function resolveMerchants(
  domains: string[]
): Promise<Map<string, { merchant_name: string; platform: string | null }>> {
  const out = new Map<string, { merchant_name: string; platform: string | null }>();
  if (domains.length === 0) return out;

  // user_merchants 有 140 万+ 行，把 merchant_url 拉回 Node 再比对不现实，
  // 交给 MySQL 在子查询里剥出域名后按 IN 收窄，整表只扫一次。
  const placeholders = domains.map(() => "?").join(",");
  const sql = `
    SELECT dom, MIN(merchant_name) AS merchant_name, MIN(platform) AS platform
    FROM (
      SELECT LOWER(TRIM(LEADING 'www.' FROM
        SUBSTRING_INDEX(SUBSTRING_INDEX(
          REPLACE(REPLACE(LOWER(merchant_url), 'https://', ''), 'http://', '')
        , '/', 1), '?', 1))) AS dom,
        merchant_name, platform
      FROM user_merchants
      WHERE is_deleted = 0 AND merchant_url IS NOT NULL AND merchant_url <> ''
    ) t
    WHERE dom IN (${placeholders})
    GROUP BY dom
  `;
  const rows = await prisma.$queryRawUnsafe<
    Array<{ dom: string; merchant_name: string | null; platform: string | null }>
  >(sql, ...domains);

  for (const r of rows) {
    const name = (r.merchant_name ?? "").trim();
    if (!r.dom || !name) continue;
    out.set(r.dom, { merchant_name: name, platform: r.platform ?? null });
  }
  return out;
}

/**
 * 一次性回补：alert_log.domain 这一列是 D-213 才加的，历史行全空。
 * 域名此前只写进了 notifications.metadata，从那里捞回来填上。
 *
 * 同一条创意的域名是固定的，所以先聚合出 creative_id → domain（几百条），
 * 再按 creative_id 批量回填，避免对着三万行日志逐条 update。
 */
export async function backfillAlertDomains(): Promise<{
  creatives: number;
  rows_updated: number;
}> {
  const domainByCreative = new Map<string, string>();
  let cursor = BigInt(0);

  for (;;) {
    const rows = await prisma.notifications.findMany({
      where: { id: { gt: cursor }, metadata: { contains: "atc_watchlist" } },
      select: { id: true, metadata: true },
      orderBy: { id: "asc" },
      take: 1000,
    });
    if (rows.length === 0) break;
    cursor = rows[rows.length - 1].id;

    for (const r of rows) {
      if (!r.metadata) continue;
      try {
        const m = JSON.parse(r.metadata) as { creative_id?: string; domain?: string | null };
        const dom = normalizeDomain(m.domain);
        if (m.creative_id && dom) domainByCreative.set(m.creative_id, dom);
      } catch {
        // 个别脏 metadata 跳过即可，不值得中断回补
      }
    }
  }

  let rowsUpdated = 0;
  for (const [creativeId, domain] of domainByCreative) {
    const res = await prisma.user_atc_alert_log.updateMany({
      where: { creative_id: creativeId, domain: null },
      data: { domain },
    });
    rowsUpdated += res.count;
  }

  return { creatives: domainByCreative.size, rows_updated: rowsUpdated };
}

export async function syncAtcRecommendations(
  opts: AtcRecSyncOptions = {}
): Promise<AtcRecSyncResult> {
  const dryRun = opts.dryRun === true;
  const batch = `ATC-${new Date().toISOString().replace(/[-:T.]/g, "").slice(0, 14)}`;
  const result: AtcRecSyncResult = {
    dry_run: dryRun,
    scanned_domains: 0,
    matched: 0,
    unmatched: 0,
    skipped_official: 0,
    created: 0,
    updated: 0,
    retired: 0,
    batch,
  };

  // 1. 聚合窗口内的活跃域名：同一域名可能被多个广告主/多条创意命中，天数取最大、最后在投日取最新
  const cutoff = new Date();
  cutoff.setUTCHours(0, 0, 0, 0);
  cutoff.setUTCDate(cutoff.getUTCDate() - ACTIVE_WINDOW_DAYS);

  const logs = await prisma.user_atc_alert_log.findMany({
    where: { domain: { not: null }, alerted_date: { gte: cutoff } },
    select: { domain: true, days: true, alerted_date: true },
  });

  const active = new Map<string, { days: number; lastSeen: Date }>();
  for (const row of logs) {
    const dom = normalizeDomain(row.domain);
    if (!dom) continue;
    const cur = active.get(dom);
    if (!cur) {
      active.set(dom, { days: row.days, lastSeen: row.alerted_date });
      continue;
    }
    if (row.days > cur.days) cur.days = row.days;
    if (row.alerted_date > cur.lastSeen) cur.lastSeen = row.alerted_date;
  }

  // 天数门槛在聚合后判，避免同一域名的短命创意把长期投放的记录挤掉
  for (const [dom, v] of active) {
    if (v.days < MIN_DAYS) active.delete(dom);
  }
  result.scanned_domains = active.size;

  // 2. 反查商家名
  const resolved = await resolveMerchants([...active.keys()]);
  result.matched = resolved.size;
  result.unmatched = active.size - resolved.size;

  // 3. 已在官方名单（sheets / excel）里的商家跳过，不重复收录
  const official = await prisma.merchant_recommendations.findMany({
    where: { is_deleted: 0, source: { not: "atc" } },
    select: { merchant_name: true },
  });
  const officialSet = new Set(official.map((r) => r.merchant_name.trim().toLowerCase()));

  // 4. 现有 atc 批次，按域名索引（含已软删的，同行重新投放时要复活）
  const existingRows = await prisma.merchant_recommendations.findMany({
    where: { source: "atc" },
    select: { id: true, atc_domain: true, is_deleted: true },
  });
  const existing = new Map<string, { id: bigint; is_deleted: number }>();
  for (const row of existingRows) {
    const dom = normalizeDomain(row.atc_domain);
    if (dom) existing.set(dom, { id: row.id, is_deleted: row.is_deleted });
  }

  // 5. 逐个域名落库
  const keptDomains = new Set<string>();
  for (const [dom, stat] of active) {
    const hit = resolved.get(dom);
    if (!hit) continue;

    if (officialSet.has(hit.merchant_name.trim().toLowerCase())) {
      result.skipped_official++;
      continue;
    }

    keptDomains.add(dom);
    const prev = existing.get(dom);
    if (prev) {
      if (!dryRun) {
        await prisma.merchant_recommendations.update({
          where: { id: prev.id },
          data: {
            merchant_name: hit.merchant_name,
            affiliate: hit.platform,
            atc_days: stat.days,
            atc_last_seen: stat.lastSeen,
            is_deleted: 0,
            upload_batch: batch,
          },
        });
      }
      result.updated++;
    } else {
      if (!dryRun) {
        await prisma.merchant_recommendations.create({
          data: {
            merchant_name: hit.merchant_name,
            source: "atc",
            affiliate: hit.platform,
            website: `https://${dom}`,
            atc_domain: dom,
            atc_days: stat.days,
            atc_last_seen: stat.lastSeen,
            upload_batch: batch,
          },
        });
      }
      result.created++;
    }
  }

  // 6. 同行已停投的下架：本轮没命中、且当前还是在架状态的 atc 记录
  const toRetire = existingRows
    .filter((r) => r.is_deleted === 0 && !keptDomains.has(normalizeDomain(r.atc_domain)))
    .map((r) => r.id);
  if (toRetire.length > 0) {
    if (dryRun) {
      result.retired = toRetire.length;
    } else {
      const res = await prisma.merchant_recommendations.updateMany({
        where: { id: { in: toRetire } },
        data: { is_deleted: 1 },
      });
      result.retired = res.count;
    }
  }

  return result;
}
