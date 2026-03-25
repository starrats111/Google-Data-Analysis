/**
 * 全员批量 API 回填脚本
 * 遍历 wjzu 团队所有成员，对每个有 API 连接的成员执行：
 *   1. 拉取 API 交易数据
 *   2. 软删除旧交易（对应平台+日期范围）
 *   3. Upsert API 数据
 *   4. 关联商家/广告系列
 *   5. 重算 ads_daily_stats 佣金
 *   6. 对账验证
 */
import "dotenv/config";
import dayjs from "dayjs";
import prisma from "../src/lib/prisma";
import { fetchAllTransactions, type PlatformTransaction } from "../src/lib/platform-api";
import { normalizePlatformCode } from "../src/lib/constants";
import { TZ, parseCSTDateStart } from "../src/lib/date-utils";

const RANGE_START = "2025-11-01";
const RANGE_END = "2026-02-28";
const RANGE_END_EXCLUSIVE = "2026-03-01";
const TARGET_MONTHS = ["2025-11", "2025-12", "2026-01", "2026-02"] as const;
type TargetMonth = (typeof TARGET_MONTHS)[number];

type TxnRecord = PlatformTransaction & {
  platform: string;
  connectionId: bigint;
  connectionLabel: string;
  month: TargetMonth;
};

type Summary = {
  month: TargetMonth;
  total_commission: number;
  approved_commission: number;
  paid_commission: number;
  pending_commission: number;
  rejected_commission: number;
  orders: number;
};

function round2(v: number) { return Math.round(v * 100) / 100; }

function monthKeyFromDate(v: string | Date): TargetMonth {
  return new Date(v).toLocaleDateString("sv-SE", { timeZone: TZ, year: "numeric", month: "2-digit" }).slice(0, 7) as TargetMonth;
}

function emptySummary(month: TargetMonth): Summary {
  return { month, total_commission: 0, approved_commission: 0, paid_commission: 0, pending_commission: 0, rejected_commission: 0, orders: 0 };
}

function aggregateSummaries(items: Array<{ month: TargetMonth; commission_amount: number; status: string }>) {
  const map = new Map<TargetMonth, Summary>(TARGET_MONTHS.map((m) => [m, emptySummary(m)]));
  for (const item of items) {
    const s = map.get(item.month);
    if (!s) continue;
    const amt = Number(item.commission_amount || 0);
    s.total_commission += amt;
    s.orders += 1;
    switch (item.status) {
      case "approved": s.approved_commission += amt; break;
      case "paid": s.paid_commission += amt; break;
      case "rejected": s.rejected_commission += amt; break;
      default: s.pending_commission += amt; break;
    }
  }
  return TARGET_MONTHS.map((m) => {
    const s = map.get(m)!;
    return { ...s, total_commission: round2(s.total_commission), approved_commission: round2(s.approved_commission), paid_commission: round2(s.paid_commission), pending_commission: round2(s.pending_commission), rejected_commission: round2(s.rejected_commission) };
  });
}

function summarizeDiff(api: Summary, db: Summary) {
  return {
    month: api.month,
    delta_total: round2(api.total_commission - db.total_commission),
    delta_approved: round2(api.approved_commission - db.approved_commission),
    delta_rejected: round2(api.rejected_commission - db.rejected_commission),
    delta_paid: round2(api.paid_commission - db.paid_commission),
    delta_pending: round2(api.pending_commission - db.pending_commission),
    delta_orders: api.orders - db.orders,
  };
}

// ─── Helper functions (same as wj07 script) ───

async function normalizeExistingTransactionPlatforms(userId: bigint) {
  const rows = await prisma.$queryRawUnsafe<{ platform: string }[]>(
    "SELECT DISTINCT platform FROM affiliate_transactions WHERE user_id = ? AND is_deleted = 0", userId);
  for (const row of rows) {
    const n = normalizePlatformCode(row.platform);
    if (n !== row.platform) {
      await prisma.affiliate_transactions.updateMany({ where: { user_id: userId, platform: row.platform, is_deleted: 0 }, data: { platform: n } });
    }
  }
}

async function linkTransactionsToMerchants(userId: bigint) {
  await normalizeExistingTransactionPlatforms(userId);
  const r1 = await prisma.$executeRawUnsafe(`UPDATE affiliate_transactions t JOIN user_merchants m ON t.user_id=m.user_id AND t.merchant_id=m.merchant_id AND t.platform=m.platform SET t.user_merchant_id=m.id WHERE t.user_id=? AND t.user_merchant_id=0 AND t.is_deleted=0 AND m.is_deleted=0 AND t.merchant_id!=''`, userId);
  const r2 = await prisma.$executeRawUnsafe(`UPDATE affiliate_transactions t JOIN user_merchants m ON t.user_id=m.user_id AND t.merchant_id=m.merchant_id SET t.user_merchant_id=m.id WHERE t.user_id=? AND t.user_merchant_id=0 AND t.is_deleted=0 AND m.is_deleted=0 AND t.merchant_id!=''`, userId);
  const r3 = await prisma.$executeRawUnsafe(`UPDATE affiliate_transactions t JOIN user_merchants m ON t.user_id=m.user_id AND t.merchant_name=m.merchant_name AND t.platform=m.platform SET t.user_merchant_id=m.id WHERE t.user_id=? AND t.user_merchant_id=0 AND t.is_deleted=0 AND m.is_deleted=0 AND t.merchant_name!=''`, userId);
  return { exact: Number(r1||0), fb_mid: Number(r2||0), fb_name: Number(r3||0) };
}

function parseCampaignName(name: string): { platform: string; mid: string } | null {
  if (!name) return null;
  const parts = name.split(/[-\s]+/);
  if (parts.length < 4) return null;
  const rawP = parts[1]?.trim();
  const mid = parts[parts.length - 1]?.trim();
  if (!rawP || !mid || !/^\d+$/.test(mid)) return null;
  return { platform: normalizePlatformCode(rawP), mid };
}

async function linkCampaignsToMerchants(userId: bigint) {
  const unlinked = await prisma.campaigns.findMany({
    where: { user_id: userId, user_merchant_id: BigInt(0), is_deleted: 0, google_campaign_id: { not: null } },
    select: { id: true, campaign_name: true }, take: 500,
  });
  if (!unlinked.length) return 0;
  const ums = await prisma.user_merchants.findMany({ where: { user_id: userId, is_deleted: 0 }, select: { id: true, platform: true, merchant_id: true, status: true } });
  const idx = new Map(ums.map((m) => [`${normalizePlatformCode(m.platform)}_${m.merchant_id}`, m]));
  let linked = 0;
  const ops: Promise<unknown>[] = [];
  const claimed = new Set<bigint>();
  for (const c of unlinked) {
    const p = parseCampaignName(c.campaign_name || "");
    if (!p) continue;
    const m = idx.get(`${p.platform}_${p.mid}`);
    if (!m) continue;
    ops.push(prisma.campaigns.update({ where: { id: c.id }, data: { user_merchant_id: m.id } }));
    if (m.status !== "claimed" && !claimed.has(m.id)) {
      claimed.add(m.id);
      ops.push(prisma.user_merchants.update({ where: { id: m.id }, data: { status: "claimed", claimed_at: new Date() } }));
    }
    linked++;
    if (ops.length >= 20) await Promise.all(ops.splice(0));
  }
  if (ops.length) await Promise.all(ops);
  return linked;
}

async function claimLinkedMerchants(userId: bigint) {
  const rows = await prisma.campaigns.findMany({
    where: { user_id: userId, is_deleted: 0, user_merchant_id: { not: BigInt(0) }, google_campaign_id: { not: null } },
    select: { user_merchant_id: true }, distinct: ["user_merchant_id"],
  });
  if (!rows.length) return 0;
  const r = await prisma.user_merchants.updateMany({
    where: { id: { in: rows.map((r) => r.user_merchant_id) }, user_id: userId, is_deleted: 0, status: { not: "claimed" } },
    data: { status: "claimed", claimed_at: new Date() },
  });
  return r.count;
}

async function updateDailyStatsCommission(userId: bigint, startDate: Date, endExclusive: Date): Promise<number> {
  const txnAgg = await prisma.$queryRawUnsafe<{ user_merchant_id: bigint; txn_date: string; total_commission: number; rejected_commission: number; order_count: number }[]>(
    `SELECT user_merchant_id, DATE(transaction_time) as txn_date, SUM(CAST(commission_amount AS DECIMAL(12,2))) as total_commission, SUM(CASE WHEN status='rejected' THEN CAST(commission_amount AS DECIMAL(12,2)) ELSE 0 END) as rejected_commission, COUNT(*) as order_count FROM affiliate_transactions WHERE user_id=? AND is_deleted=0 AND transaction_time>=? AND transaction_time<? GROUP BY user_merchant_id, DATE(transaction_time)`,
    userId, startDate, endExclusive);
  if (!txnAgg?.length) return 0;
  const mids = [...new Set(txnAgg.map((a) => a.user_merchant_id))].filter((id) => id && id !== BigInt(0));
  if (!mids.length) return 0;
  const camps = await prisma.campaigns.findMany({ where: { user_id: userId, user_merchant_id: { in: mids }, is_deleted: 0 }, select: { id: true, user_merchant_id: true, google_status: true, updated_at: true } });
  const prio: Record<string, number> = { ENABLED: 0, PAUSED: 1, REMOVED: 2 };
  camps.sort((a, b) => { const ap = prio[a.google_status || ""] ?? 2, bp = prio[b.google_status || ""] ?? 2; return ap !== bp ? ap - bp : b.updated_at.getTime() - a.updated_at.getTime(); });
  const cByM = new Map<string, bigint[]>();
  for (const c of camps) { const k = String(c.user_merchant_id); if (!cByM.has(k)) cByM.set(k, []); cByM.get(k)!.push(c.id); }
  const cIds = camps.map((c) => c.id);
  const stats = cIds.length ? await prisma.ads_daily_stats.findMany({ where: { campaign_id: { in: cIds }, date: { gte: startDate, lt: endExclusive } }, select: { id: true, campaign_id: true, date: true } }) : [];
  const sMap = new Map(stats.map((s) => [`${s.campaign_id}_${s.date.toISOString().split("T")[0]}`, s.id]));
  const ops: Array<() => Promise<unknown>> = [];
  let updated = 0;
  for (const agg of txnAgg) {
    if (!agg.user_merchant_id || agg.user_merchant_id === BigInt(0)) continue;
    const cids = cByM.get(String(agg.user_merchant_id));
    if (!cids?.length) continue;
    const d = String(agg.txn_date).split("T")[0];
    const data = { commission: Number(agg.total_commission), rejected_commission: Number(agg.rejected_commission), orders: Number(agg.order_count) };
    let wrote = false;
    for (const cid of cids) {
      const sid = sMap.get(`${cid}_${d}`);
      if (sid) {
        ops.push(wrote ? () => prisma.ads_daily_stats.update({ where: { id: sid }, data: { commission: 0, rejected_commission: 0, orders: 0 } }) : () => prisma.ads_daily_stats.update({ where: { id: sid }, data }));
        if (!wrote) { wrote = true; updated++; }
      }
    }
    if (!wrote) {
      ops.push(() => prisma.ads_daily_stats.create({ data: { user_id: userId, user_merchant_id: agg.user_merchant_id, campaign_id: cids[0], date: new Date(agg.txn_date), cost: 0, clicks: 0, impressions: 0, ...data } }).catch(() => undefined));
      updated++;
    }
  }
  for (let i = 0; i < ops.length; i += 50) await Promise.all(ops.slice(i, i + 50).map((fn) => fn()));
  return updated;
}

async function ensureMerchantMap(userId: bigint) {
  const ums = await prisma.user_merchants.findMany({ where: { user_id: userId, is_deleted: 0 }, select: { id: true, merchant_id: true, platform: true, merchant_name: true } });
  return new Map(ums.map((m) => [`${normalizePlatformCode(m.platform)}_${m.merchant_id}`, m]));
}

async function ensureMissingMerchants(userId: bigint, txns: TxnRecord[], merchantMap: Map<string, { id: bigint; merchant_id: string; platform: string; merchant_name: string }>) {
  const missing = new Map<string, { merchantId: string; name: string; platform: string; connectionId: bigint }>();
  for (const t of txns) {
    const mid = t.merchant_id || "";
    if (!mid) continue;
    const k = `${t.platform}_${mid}`;
    if (!merchantMap.has(k) && !missing.has(k)) missing.set(k, { merchantId: mid, name: t.merchant || "", platform: t.platform, connectionId: t.connectionId });
  }
  for (const item of missing.values()) {
    try {
      let ex = await prisma.user_merchants.findFirst({ where: { user_id: userId, platform: item.platform, merchant_id: item.merchantId, is_deleted: 0 }, select: { id: true, merchant_id: true, platform: true, merchant_name: true } });
      if (!ex) ex = await prisma.user_merchants.create({ data: { user_id: userId, platform: item.platform, merchant_id: item.merchantId, merchant_name: item.name, status: "available", platform_connection_id: item.connectionId }, select: { id: true, merchant_id: true, platform: true, merchant_name: true } });
      merchantMap.set(`${item.platform}_${item.merchantId}`, ex);
    } catch {
      const ex = await prisma.user_merchants.findFirst({ where: { user_id: userId, platform: item.platform, merchant_id: item.merchantId, is_deleted: 0 }, select: { id: true, merchant_id: true, platform: true, merchant_name: true } });
      if (ex) merchantMap.set(`${item.platform}_${item.merchantId}`, ex);
    }
  }
}

async function loadDbSummary(userId: bigint) {
  const rows = await prisma.affiliate_transactions.findMany({
    where: { user_id: userId, is_deleted: 0, transaction_time: { gte: parseCSTDateStart(RANGE_START), lt: parseCSTDateStart(RANGE_END_EXCLUSIVE) } },
    select: { transaction_time: true, commission_amount: true, status: true },
  });
  return aggregateSummaries(rows.map((r) => ({ month: monthKeyFromDate(r.transaction_time), commission_amount: Number(r.commission_amount || 0), status: r.status || "pending" })));
}

// ─── 单用户回填 ───

async function backfillUser(userId: bigint, username: string) {
  const connections = await prisma.platform_connections.findMany({
    where: { user_id: userId, is_deleted: 0, status: "connected" },
    select: { id: true, platform: true, account_name: true, api_key: true },
    orderBy: [{ platform: "asc" }, { id: "asc" }],
  });
  const validConns = connections.filter((c) => c.api_key && c.api_key.length > 5);
  if (!validConns.length) return { username, skipped: true, reason: "no_api_connections" };

  console.log(`\n── [${username}] 开始回填 (${validConns.length} 个连接: ${validConns.map((c) => `${c.platform}/${c.account_name}`).join(", ")}) ──`);

  // 1. 拉取 API 数据
  const apiTxnsMap = new Map<string, TxnRecord>();
  const fetchErrors: string[] = [];
  for (const conn of validConns) {
    const platform = normalizePlatformCode(conn.platform);
    const label = conn.account_name || `${platform}-${conn.id}`;
    try {
      const result = await fetchAllTransactions(platform, conn.api_key!, RANGE_START, RANGE_END);
      if (result.error) { fetchErrors.push(`${label}: ${result.error}`); continue; }
      for (const txn of result.transactions) {
        if (!txn.transaction_id) continue;
        const month = monthKeyFromDate(txn.transaction_time);
        if (!TARGET_MONTHS.includes(month)) continue;
        apiTxnsMap.set(`${platform}::${txn.transaction_id}`, { ...txn, platform, connectionId: conn.id, connectionLabel: label, month });
      }
    } catch (e) {
      fetchErrors.push(`${label}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  const apiTxns = [...apiTxnsMap.values()];
  console.log(`  API 拉取: ${apiTxns.length} 条交易${fetchErrors.length ? `, ${fetchErrors.length} 个错误` : ""}`);

  if (apiTxns.length === 0 && fetchErrors.length > 0) {
    return { username, skipped: true, reason: "all_fetch_failed", errors: fetchErrors };
  }

  const apiSummary = aggregateSummaries(apiTxns.map((t) => ({ month: t.month, commission_amount: t.commission_amount, status: t.status })));

  // 2. 确保商家存在
  const merchantMap = await ensureMerchantMap(userId);
  await ensureMissingMerchants(userId, apiTxns, merchantMap);

  // 3. 软删除旧数据
  const activePlatforms = [...new Set(validConns.map((c) => normalizePlatformCode(c.platform)))];
  const softDeleted = await prisma.affiliate_transactions.updateMany({
    where: { user_id: userId, is_deleted: 0, platform: { in: activePlatforms }, transaction_time: { gte: parseCSTDateStart(RANGE_START), lt: parseCSTDateStart(RANGE_END_EXCLUSIVE) } },
    data: { is_deleted: 1 },
  });
  console.log(`  软删除: ${softDeleted.count} 条`);

  // 4. Upsert API 数据
  let upserted = 0;
  for (let i = 0; i < apiTxns.length; i += 50) {
    const batch = apiTxns.slice(i, i + 50);
    await Promise.all(batch.map((txn) => {
      const mid = txn.merchant_id || "";
      const m = merchantMap.get(`${txn.platform}_${mid}`);
      const umid = m ? m.id : BigInt(0);
      const mname = txn.merchant || m?.merchant_name || "";
      return prisma.affiliate_transactions.upsert({
        where: { platform_transaction_id: { platform: txn.platform, transaction_id: txn.transaction_id } },
        create: { user_id: userId, user_merchant_id: umid, platform_connection_id: txn.connectionId, platform: txn.platform, merchant_id: mid, merchant_name: mname, transaction_id: txn.transaction_id, transaction_time: new Date(txn.transaction_time), order_amount: txn.order_amount || 0, commission_amount: txn.commission_amount || 0, currency: "USD", status: txn.status, raw_status: txn.raw_status || "" },
        update: { user_merchant_id: umid, platform_connection_id: txn.connectionId, platform: txn.platform, merchant_id: mid, merchant_name: mname, transaction_time: new Date(txn.transaction_time), order_amount: txn.order_amount || 0, commission_amount: txn.commission_amount || 0, currency: "USD", status: txn.status, raw_status: txn.raw_status || "", is_deleted: 0 },
      });
    }));
    upserted += batch.length;
  }
  console.log(`  Upsert: ${upserted} 条`);

  // 5. 关联
  await linkTransactionsToMerchants(userId);
  await linkCampaignsToMerchants(userId);
  await claimLinkedMerchants(userId);

  // 6. 重算 daily stats
  for (const month of TARGET_MONTHS) {
    const start = parseCSTDateStart(`${month}-01`);
    const endEx = parseCSTDateStart(dayjs(`${month}-01`).add(1, "month").format("YYYY-MM-DD"));
    await prisma.ads_daily_stats.updateMany({ where: { user_id: userId, date: { gte: start, lt: endEx } }, data: { commission: 0, rejected_commission: 0, orders: 0 } });
    await updateDailyStatsCommission(userId, start, endEx);
  }

  // 7. 对账
  const dbSummary = await loadDbSummary(userId);
  const comparison = TARGET_MONTHS.map((m, i) => summarizeDiff(apiSummary[i], dbSummary[i]));
  const allMatch = comparison.every((c) => c.delta_total === 0 && c.delta_orders === 0);

  console.log(`  对账: ${allMatch ? "✅ 全部对齐" : "⚠️ 存在差异"}`);

  return {
    username,
    skipped: false,
    soft_deleted: softDeleted.count,
    upserted,
    api_txns: apiTxns.length,
    all_match: allMatch,
    api_summary: apiSummary,
    db_summary: dbSummary,
    comparison,
    fetch_errors: fetchErrors.length ? fetchErrors : undefined,
  };
}

// ─── Main ───

async function main() {
  // 获取 wjzu 团队所有成员
  const wjzu = await prisma.users.findFirst({ where: { username: "wjzu", is_deleted: 0 }, select: { id: true, team_id: true } });
  if (!wjzu?.team_id) throw new Error("未找到 wjzu 或无 team_id");

  const members = await prisma.users.findMany({
    where: { team_id: wjzu.team_id, is_deleted: 0, role: { not: "admin" } },
    select: { id: true, username: true },
    orderBy: { id: "asc" },
  });

  // 排除 wjzu 本人（leader，无交易数据）
  const targets = members.filter((m) => m.username !== "wjzu");
  console.log(`全员回填: ${targets.map((m) => m.username).join(", ")}`);
  console.log(`日期范围: ${RANGE_START} ~ ${RANGE_END}`);

  const results: unknown[] = [];
  for (const member of targets) {
    try {
      const result = await backfillUser(member.id, member.username);
      results.push(result);
    } catch (e) {
      console.error(`\n── [${member.username}] 回填失败: ${e instanceof Error ? e.message : String(e)} ──`);
      results.push({ username: member.username, skipped: true, reason: "error", error: String(e) });
    }
  }

  console.log("\n\n========== 全员回填汇总 ==========");
  console.log(JSON.stringify(results, (_k, v) => (typeof v === "bigint" ? v.toString() : v), 2));
}

main()
  .catch((e) => { console.error(e); process.exitCode = 1; })
  .finally(() => prisma["$disconnect"]());
