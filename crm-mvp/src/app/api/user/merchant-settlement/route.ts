import { NextRequest } from "next/server";
import { withUser } from "@/lib/api-handler";
import { apiSuccess, apiError } from "@/lib/constants";
import { serializeData } from "@/lib/auth";
import prisma from "@/lib/prisma";

/**
 * D-374 商家结算率表（用户端只读查询）
 * GET ?search=&platform=&page=&pageSize=&run_status=
 *     &settlement_min/max=&chargeback_min/max=&commission_min/max=
 *     &sortField=&sortOrder=
 *
 * 商家清单本身（哪些「平台+MID」出现在表里）仍由管理员上传的 Excel
 * （/api/admin/merchant-settlement-upload）决定。
 *
 * D-383（wj04 反馈：结算率/拒付率/订单数/总佣金是上传时刻的静态快照，跟系统里
 * 实际跑的订单脱节）：这四个数字改为全系统实时聚合 affiliate_transactions，
 * 口径对齐「数据中心-结算查询」（D-335）：
 *   结算率 = (approved+paid) / 总佣金 * 100%
 *   拒付率 = rejected / 总佣金 * 100%
 *   总佣金 = 该 platform+merchant_id 下所有状态（含 pending）佣金总和
 * 全系统所有用户汇总、不限时间窗（全部历史）。没有交易记录的行记 0。
 *
 * 坑：merchant_settlement_rates.platform/mid 是 utf8mb4_unicode_ci，
 * affiliate_transactions.platform/merchant_id 是 utf8mb4_general_ci，
 * 两边直接 JOIN/WHERE 比较会报 "Illegal mix of collations"——
 * 聚合改成整表 GROUP BY（不做跨表 JOIN），在内存里按 "platform:merchant_id"
 * 键回填，天然绕开这个问题。
 *
 * D-376 修正（沿用不变）：同名商家在不同联盟平台是完全独立的商家，
 * 比对 user_merchants 必须按「平台+MID」精确匹配，不能只比商家名。
 * 「认领」≠「在跑」：can_run 要求挂着 google_status=ENABLED 的广告系列。
 *
 * 这批数据量小（merchant_settlement_rates 约 1750 行），筛选/排序/分页
 * 全部在内存里做，不在 SQL 层处理。
 */
export const GET = withUser(async (req: NextRequest, { user }) => {
  const { searchParams } = new URL(req.url);
  const search = searchParams.get("search") || "";
  const platform = searchParams.get("platform") || "";
  const page = parseInt(searchParams.get("page") || "1");
  const pageSize = parseInt(searchParams.get("pageSize") || "50");
  const runStatus = searchParams.get("run_status") || ""; // not_in_db / claimable / can_run / claimed_not_running
  const sortField = searchParams.get("sortField") || "settlement_rate";
  const sortOrder = (searchParams.get("sortOrder") || "desc") as "asc" | "desc";
  const settlementMin = parseFloatOrNull(searchParams.get("settlement_min"));
  const settlementMax = parseFloatOrNull(searchParams.get("settlement_max"));
  const chargebackMin = parseFloatOrNull(searchParams.get("chargeback_min"));
  const chargebackMax = parseFloatOrNull(searchParams.get("chargeback_max"));
  const commissionMin = parseFloatOrNull(searchParams.get("commission_min"));
  const commissionMax = parseFloatOrNull(searchParams.get("commission_max"));
  const userId = BigInt(user.userId);

  const where: Record<string, unknown> = { is_deleted: 0 };
  if (search) where.merchant_name = { contains: search };
  if (platform) where.platform = platform;

  const rows = await prisma.merchant_settlement_rates.findMany({ where: where as never });

  // ── 实时聚合 affiliate_transactions（全系统、全部历史、按 platform+merchant_id）──
  // collation 冲突绕开：不跨表 JOIN，整表 GROUP BY 后在内存按 key 回填
  const aggRows = await prisma.$queryRawUnsafe<{
    platform: string; merchant_id: string;
    total: number; approved_paid: number; rejected: number; orders: number;
  }[]>(`
    SELECT
      platform, merchant_id,
      SUM(CAST(commission_amount AS DECIMAL(14,4))) AS total,
      SUM(CASE WHEN status IN ('approved','paid') THEN CAST(commission_amount AS DECIMAL(14,4)) ELSE 0 END) AS approved_paid,
      SUM(CASE WHEN status = 'rejected' THEN CAST(commission_amount AS DECIMAL(14,4)) ELSE 0 END) AS rejected,
      COUNT(*) AS orders
    FROM affiliate_transactions
    WHERE is_deleted = 0
    GROUP BY platform, merchant_id
  `);
  const aggMap = new Map<string, { total: number; approvedPaid: number; rejected: number; orders: number }>();
  for (const r of aggRows) {
    aggMap.set(`${r.platform}:${r.merchant_id}`, {
      total: Number(r.total || 0), approvedPaid: Number(r.approved_paid || 0),
      rejected: Number(r.rejected || 0), orders: Number(r.orders || 0),
    });
  }

  const fix2 = (n: number) => +n.toFixed(2);
  const live = rows.map((it) => {
    const agg = it.mid ? aggMap.get(`${it.platform}:${it.mid}`) : undefined;
    const total = agg?.total || 0;
    const settlementRate = total > 0 ? fix2((agg!.approvedPaid / total) * 100) : 0;
    const chargebackRate = total > 0 ? fix2((agg!.rejected / total) * 100) : 0;
    return {
      ...it,
      settlement_rate: settlementRate / 100, // 保持原字段 0-1 小数单位，前端按 *100 渲染
      chargeback_rate: chargebackRate / 100,
      order_count: agg?.orders ?? 0,
      total_commission: fix2(total),
    };
  });

  // ── 比对 user_merchants（D-376：按平台+MID 精确匹配）────────────────────
  const platforms = Array.from(new Set(live.map((i) => i.platform)));
  const names = live.map((i) => i.merchant_name);
  const mine = platforms.length > 0
    ? await prisma.user_merchants.findMany({
        where: { user_id: userId, is_deleted: 0, platform: { in: platforms }, merchant_name: { in: names } },
        select: { id: true, merchant_name: true, merchant_id: true, status: true, platform: true },
      })
    : [];

  const myMerchantIds = mine.map((m) => m.id);
  const enabledIds = myMerchantIds.length > 0
    ? await prisma.campaigns.findMany({
        where: { user_merchant_id: { in: myMerchantIds }, is_deleted: 0, google_status: "ENABLED" },
        select: { user_merchant_id: true },
      })
    : [];
  const enabledSet = new Set(enabledIds.map((c) => c.user_merchant_id.toString()));

  const rank = (m: (typeof mine)[0]) =>
    enabledSet.has(m.id.toString()) ? 2 : m.status !== "available" ? 1 : 0;
  const byMid = new Map<string, (typeof mine)[0]>();
  const byPlatName = new Map<string, (typeof mine)[0]>();
  for (const m of mine) {
    if (m.merchant_id) {
      const k = `${m.platform}:${m.merchant_id}`;
      const prev = byMid.get(k);
      if (!prev || rank(m) > rank(prev)) byMid.set(k, m);
    }
    const nk = `${m.platform}:${m.merchant_name.toLowerCase()}`;
    const prevN = byPlatName.get(nk);
    if (!prevN || rank(m) > rank(prevN)) byPlatName.set(nk, m);
  }

  type RunStatus = "not_in_db" | "claimable" | "can_run" | "claimed_not_running";
  const enriched = live.map((it) => {
    const match =
      (it.mid ? byMid.get(`${it.platform}:${it.mid}`) : undefined) ||
      byPlatName.get(`${it.platform}:${it.merchant_name.toLowerCase()}`);
    const myStatus = match ? match.status : null;
    const running = match ? enabledSet.has(match.id.toString()) : false;
    const status: RunStatus =
      myStatus == null ? "not_in_db" : running ? "can_run" : myStatus === "available" ? "claimable" : "claimed_not_running";
    return {
      ...it,
      my_status: myStatus, // null=未入库 / available=可认领 / claimed/paused=已认领但未必在投
      my_platform: match ? match.platform : null,
      can_run: running, // 必须同平台+MID 匹配上，且有真正 ENABLED 的广告系列
      run_status: status,
    };
  });

  // ── 筛选（区间按百分数/美元原始单位传入，与 0-1 小数单位的存储值换算） ──────
  let filtered = enriched;
  if (settlementMin != null) filtered = filtered.filter((r) => r.settlement_rate * 100 >= settlementMin);
  if (settlementMax != null) filtered = filtered.filter((r) => r.settlement_rate * 100 <= settlementMax);
  if (chargebackMin != null) filtered = filtered.filter((r) => r.chargeback_rate * 100 >= chargebackMin);
  if (chargebackMax != null) filtered = filtered.filter((r) => r.chargeback_rate * 100 <= chargebackMax);
  if (commissionMin != null) filtered = filtered.filter((r) => r.total_commission >= commissionMin);
  if (commissionMax != null) filtered = filtered.filter((r) => r.total_commission <= commissionMax);
  if (runStatus) filtered = filtered.filter((r) => r.run_status === runStatus);

  // ── 排序 ──────────────────────────────────────────────────────────────
  const SORTABLE = new Set(["merchant_name", "settlement_rate", "chargeback_rate", "total_commission"]);
  const field = SORTABLE.has(sortField) ? sortField : "settlement_rate";
  const dir = sortOrder === "asc" ? 1 : -1;
  filtered = [...filtered].sort((a, b) => {
    const av = (a as Record<string, unknown>)[field];
    const bv = (b as Record<string, unknown>)[field];
    if (typeof av === "string" && typeof bv === "string") return dir * av.localeCompare(bv);
    return dir * ((Number(av) || 0) - (Number(bv) || 0));
  });

  const total = filtered.length;
  const items = filtered.slice((page - 1) * pageSize, page * pageSize);

  return apiSuccess(serializeData({ items, total, page, pageSize }));
});

function parseFloatOrNull(v: string | null): number | null {
  if (v == null || v === "") return null;
  const n = parseFloat(v);
  return isNaN(n) ? null : n;
}
