/**
 * D-245 复盘分析：用 Google Ads 变更历史（change_event，Google 保留 30 天）
 * 把「近似暂停时间」修正为精确暂停时间。
 *
 * 背景：靠消费数据推断暂停日天然有 ±1 天歧义（暂停当天可能已消费 / 暂停前可能有零消费日）；
 * Sheet 状态同步记录的是「发现时刻」，员工在 Google 界面直接暂停的最多晚一天。
 * change_event 记录了每次 status 变更的精确时刻，是唯一可靠来源（仅保留 30 天）。
 *
 * 使用方：
 * - daily-sync Step 2.7：每日把近几天 pause_source='sync' 的行精确化；
 * - scripts/backfill-exact-pause-times.ts：一次性修正存量 backfill/sync 行。
 */
import dayjs from "dayjs";
import utc from "dayjs/plugin/utc";
import timezone from "dayjs/plugin/timezone";
import prisma from "@/lib/prisma";
import { queryGoogleAds, type MccCredentials } from "./client";

dayjs.extend(utc);
dayjs.extend(timezone);

/** 精确化后的暂停来源标识（区别于近似的 sync/backfill，UI 不再标 ≈） */
export const PAUSE_SOURCE_CHANGE_HISTORY = "change_history";

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** 一次查询拿 MCC 下所有子账户的时区（change_date_time 以账户时区返回，换算 UTC 必需） */
export async function fetchClientTimeZones(credentials: MccCredentials): Promise<Map<string, string>> {
  const rows = await queryGoogleAds(credentials, credentials.mcc_id, `
    SELECT customer_client.id, customer_client.time_zone
    FROM customer_client
  `);
  const map = new Map<string, string>();
  for (const row of rows) {
    const cc = row.customerClient as Record<string, unknown> | undefined;
    const id = String(cc?.id ?? "");
    const tz = String(cc?.timeZone ?? "");
    if (id && tz) map.set(id, tz);
  }
  return map;
}

/**
 * 查询单个 CID 近 N 天内「系列被置 PAUSED」的精确时间。
 * 返回 Map<google_campaign_id, UTC Date>，每系列取最近一次暂停事件。
 */
export async function fetchExactPauseTimes(
  credentials: MccCredentials,
  customerId: string,
  accountTimeZone: string,
  lookbackDays = 29,
): Promise<Map<string, Date>> {
  const nowTz = dayjs().tz(accountTimeZone);
  const start = nowTz.subtract(lookbackDays, "day").format("YYYY-MM-DD 00:00:00");
  const end = nowTz.format("YYYY-MM-DD 23:59:59");
  // change_event 强制要求有限日期范围（≤30 天）+ LIMIT
  const rows = await queryGoogleAds(credentials, customerId, `
    SELECT
      change_event.change_date_time,
      change_event.campaign,
      change_event.changed_fields,
      change_event.new_resource
    FROM change_event
    WHERE change_event.change_date_time >= '${start}'
      AND change_event.change_date_time <= '${end}'
      AND change_event.change_resource_type = 'CAMPAIGN'
    ORDER BY change_event.change_date_time DESC
    LIMIT 9900
  `);
  const map = new Map<string, Date>();
  for (const row of rows) {
    const ev = row.changeEvent as Record<string, unknown> | undefined;
    if (!ev) continue;
    // REST 下 FieldMask 序列化为逗号分隔字符串，如 "status" / "status,name"
    const changedFields = String(ev.changedFields ?? "");
    if (!/(^|,)\s*status\s*(,|$)/.test(changedFields)) continue;
    const newRes = ev.newResource as Record<string, unknown> | undefined;
    const newCampaign = newRes?.campaign as Record<string, unknown> | undefined;
    if (String(newCampaign?.status ?? "") !== "PAUSED") continue;
    const gcid = String(ev.campaign ?? "").split("/").pop() || "";
    if (!gcid || map.has(gcid)) continue; // DESC 排序，首个即最近一次暂停
    const parsed = dayjs.tz(String(ev.changeDateTime ?? "").slice(0, 19), accountTimeZone);
    if (!parsed.isValid()) continue;
    map.set(gcid, parsed.utc().toDate());
  }
  return map;
}

export interface RefinePauseTimesOptions {
  /** 只处理这些 pause_source 的行（如 ["sync"] 或 ["backfill","sync"]） */
  sources: string[];
  /** 只处理 paused_at 距今不超过 N 天的行（近似值可能偏离真实值，适当放宽） */
  recentDays: number;
  /** change_event 回看天数（Google 上限 30） */
  lookbackDays?: number;
  /** 试跑：只报告不写库 */
  dryRun?: boolean;
  log?: (msg: string) => void;
}

export interface RefinePauseTimesResult {
  scanned: number;
  cidsQueried: number;
  updated: number;
  errors: number;
  /** 变更明细（dryRun 时用于人工核对） */
  changes: Array<{ campaignId: string; gcid: string; before: string; after: string }>;
}

/**
 * 把近似暂停时间批量修正为 change_event 里的精确时间。
 * 命中的行 pause_source 置为 change_history；未命中（暂停超 30 天 / 无事件）保持原值。
 */
export async function refinePauseTimesFromChangeHistory(
  opts: RefinePauseTimesOptions,
): Promise<RefinePauseTimesResult> {
  const { sources, recentDays, lookbackDays = 29, dryRun = false } = opts;
  const log = opts.log || (() => {});
  const result: RefinePauseTimesResult = { scanned: 0, cidsQueried: 0, updated: 0, errors: 0, changes: [] };

  const cutoff = new Date(Date.now() - recentDays * 86400_000);
  const targets = await prisma.campaigns.findMany({
    where: {
      is_deleted: 0,
      google_status: { in: ["PAUSED", "REMOVED"] },
      pause_source: { in: sources },
      paused_at: { gte: cutoff },
      google_campaign_id: { not: null },
      customer_id: { not: null },
      mcc_id: { not: null },
    },
    select: {
      id: true, google_campaign_id: true, customer_id: true,
      paused_at: true, mcc_id: true,
    },
  });
  result.scanned = targets.length;
  if (targets.length === 0) return result;

  // 按 MCC → CID 分组
  const byMcc = new Map<string, Map<string, typeof targets>>();
  for (const t of targets) {
    const mccKey = t.mcc_id!.toString();
    const cid = (t.customer_id || "").replace(/-/g, "");
    if (!cid) continue;
    let cidMap = byMcc.get(mccKey);
    if (!cidMap) { cidMap = new Map(); byMcc.set(mccKey, cidMap); }
    const arr = cidMap.get(cid);
    if (arr) arr.push(t);
    else cidMap.set(cid, [t]);
  }

  const mccRows = await prisma.google_mcc_accounts.findMany({
    where: { id: { in: [...byMcc.keys()].map((k) => BigInt(k)) } },
    select: { id: true, mcc_id: true, mcc_name: true, developer_token: true, service_account_json: true },
  });

  for (const mcc of mccRows) {
    const cidMap = byMcc.get(mcc.id.toString());
    if (!cidMap) continue;
    const credentials: MccCredentials = {
      mcc_id: mcc.mcc_id,
      developer_token: mcc.developer_token || "",
      service_account_json: mcc.service_account_json || "",
    };

    let tzMap = new Map<string, string>();
    try {
      tzMap = await fetchClientTimeZones(credentials);
    } catch (e) {
      log(`  [change-history] MCC ${mcc.mcc_name || mcc.mcc_id} 拉取子账户时区失败：${e instanceof Error ? e.message.slice(0, 150) : e}`);
      result.errors += 1;
      continue;
    }

    for (const [cid, camps] of cidMap) {
      const tz = tzMap.get(cid);
      if (!tz) {
        log(`  [change-history] CID ${cid} 不在 MCC ${mcc.mcc_id} 子账户列表中（可能已脱离），跳过 ${camps.length} 条`);
        continue;
      }
      try {
        const exact = await fetchExactPauseTimes(credentials, cid, tz, lookbackDays);
        result.cidsQueried += 1;
        for (const c of camps) {
          const exactAt = exact.get(c.google_campaign_id!);
          if (!exactAt) continue;
          result.changes.push({
            campaignId: c.id.toString(),
            gcid: c.google_campaign_id!,
            before: c.paused_at!.toISOString(),
            after: exactAt.toISOString(),
          });
          if (!dryRun) {
            await prisma.campaigns.update({
              where: { id: c.id },
              data: { paused_at: exactAt, pause_source: PAUSE_SOURCE_CHANGE_HISTORY },
            });
          }
          result.updated += 1;
        }
      } catch (e) {
        result.errors += 1;
        log(`  [change-history] CID ${cid} 查询变更历史失败：${e instanceof Error ? e.message.slice(0, 150) : e}`);
      }
      await sleep(150); // 对配额温和一点
    }
  }
  return result;
}
