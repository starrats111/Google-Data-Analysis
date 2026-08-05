import { NextRequest } from "next/server";
import { apiSuccess, apiError } from "@/lib/constants";
import prisma from "@/lib/prisma";
import { verifyHermesToken } from "@/lib/hermes-auth";

// D-213 / Hermes HM-A04+HM-A07：团队已验证商家 + 盈亏平衡 CPC 只读快照。
//
// 两个用途（对应 Hermes 设计方案 12.5a 判决矩阵与 12.5f CPC 限额）：
//   1) team_verified —— 该商家是否已被团队里任何人跑出过有效订单。判决硬顶取 $6 还是 $11-14 靠它。
//   2) breakeven_cpc —— 该商家每个点击能赚回多少佣金。Hermes 的出价上限 = 它 × 安全系数。
//      商家之间这个值差 300 倍以上（实测 $0.016 到 $5.35），一刀切的出价上限必然同时过松与过紧。
//
// 为什么必须走这个接口：Hermes 那台机器连不上 CRM 的库（只监听 127.0.0.1），而它自己的 SQLite
// 里只有自己投过的商家——20 名员工在 CRM 里跑出来的历史它一无所知。实测 Hermes 在投的 86 个商家
// 里有 69 个（80%）在它本地查不到任何成交记录。
//
// 只读、不写库。Hermes 端整表替换 + 本地快照兜底（接口不可达时用上一份）。
// ⚠️ 全量聚合约 17 秒，只供每天一次的同步用，不要高频轮询（服务器 2 核 3.7G）。

export const dynamic = "force-dynamic";
export const maxDuration = 60;

/** URL → 裸域名。口径与 /api/hermes/merchant-intelligence 的 toDomain 及 Hermes 端 normalizeDomain 一致 */
function toDomain(url: string | null | undefined): string {
  const s = String(url || "").trim();
  if (!s) return "";
  return s
    .replace(/^https?:\/\//i, "")
    .replace(/^www\./i, "")
    .split("/")[0]
    .split("?")[0]
    .trim()
    .toLowerCase();
}

const num = (v: unknown): number => {
  const n = Number(v ?? 0);
  return Number.isFinite(n) ? n : 0;
};
/** 四舍五入到 n 位，避免把 Decimal 的长尾小数直接甩给调用方 */
const r = (v: number, n: number): number => {
  const p = 10 ** n;
  return Math.round(v * p) / p;
};

type TxnRow = {
  platform: string;
  merchant_id: string;
  merchant_name: string | null;
  orders_all: bigint | number;
  orders_ok: bigint | number;
  commission_ok: string | number | null;
  commission_rejected: string | number | null;
  verified_by_count: bigint | number;
  first_order_at: Date | string | null;
  last_order_at: Date | string | null;
};

type AdsRow = {
  platform: string;
  merchant_id: string;
  clicks: bigint | number | null;
  cost: string | number | null;
  campaigns: bigint | number;
  users_ran: bigint | number;
};

type MetaRow = {
  platform: string;
  merchant_id: string;
  merchant_url: string | null;
  merchant_name: string | null;
};

// 订单/点击比超过这个值就认为佣金里混进了非广告流量，breakeven_cpc 不可全信。
// 取 0.3 的依据：实测「订单 ≤ 30% 点击」那 266 家的 breakeven 是 $0.565，
// 而超过这条线的 345 家高达 $2.12–$9.08，两者不是同一种东西。
const ORDERS_PER_CLICK_TRUST_MAX = 0.3;

export async function GET(req: NextRequest) {
  const authErr = verifyHermesToken(req);
  if (authErr) return authErr;

  const url = new URL(req.url);
  // 默认不限时间：这个信号问的是「该商家历史上能不能出单、每点击赚多少」，样本越全越稳。
  // 需要收窄时传 since=YYYY-MM-DD。⚠️ 佣金按 transaction_time、点击按 date，转化有延迟，
  // 窗口收得越窄佣金被截掉越多、breakeven_cpc 越偏低——所以默认全期。
  const since = url.searchParams.get("since");
  // 只想要「已验证」那批时传 verified_only=1，可把响应压掉一大半
  const verifiedOnly = url.searchParams.get("verified_only") === "1";

  try {
    // ── 1) 佣金侧：按 platform + merchant_id 聚合。
    // affiliate_transactions 自带冗余的 platform / merchant_id / merchant_name，无需 join。
    // 注意：跨用户去重在同步写入阶段已完成（见 lib/affiliate-transaction-sql.ts 的说明），
    // 统计侧不需要再对 platform_connections 做二次联查。
    const txnRows = await prisma.$queryRawUnsafe<TxnRow[]>(
      `SELECT platform,
              merchant_id,
              MAX(merchant_name) AS merchant_name,
              COUNT(*) AS orders_all,
              SUM(CASE WHEN status <> 'rejected' THEN 1 ELSE 0 END) AS orders_ok,
              ROUND(SUM(CASE WHEN status <> 'rejected'
                        THEN CAST(commission_amount AS DECIMAL(14,4)) ELSE 0 END), 4) AS commission_ok,
              ROUND(SUM(CASE WHEN status = 'rejected'
                        THEN CAST(commission_amount AS DECIMAL(14,4)) ELSE 0 END), 4) AS commission_rejected,
              COUNT(DISTINCT CASE WHEN status <> 'rejected' THEN user_id END) AS verified_by_count,
              MIN(CASE WHEN status <> 'rejected' THEN transaction_time END) AS first_order_at,
              MAX(CASE WHEN status <> 'rejected' THEN transaction_time END) AS last_order_at
         FROM affiliate_transactions
        WHERE is_deleted = 0 ${since ? "AND transaction_time >= ?" : ""}
        GROUP BY platform, merchant_id
       HAVING orders_all > 0`,
      ...(since ? [since] : []),
    );

    // ── 2) 点击/花费侧：ads_daily_stats 挂的是 user_merchant_id，借 user_merchants 换成 platform+MID。
    // 不走 campaigns：那样会多一层 join，且日表本就带 user_merchant_id。
    const adsRows = await prisma.$queryRawUnsafe<AdsRow[]>(
      `SELECT um.platform,
              um.merchant_id,
              SUM(s.clicks) AS clicks,
              ROUND(SUM(CAST(s.cost AS DECIMAL(16,6))), 6) AS cost,
              COUNT(DISTINCT s.campaign_id) AS campaigns,
              COUNT(DISTINCT s.user_id) AS users_ran
         FROM ads_daily_stats s
         JOIN user_merchants um ON um.id = s.user_merchant_id
        WHERE s.is_deleted = 0 AND um.is_deleted = 0 ${since ? "AND s.date >= ?" : ""}
        GROUP BY um.platform, um.merchant_id`,
      ...(since ? [since] : []),
    );

    // ── 3) 域名映射：CRM 没有 normalized_domain 列，只有 user_merchants.merchant_url，运行时解析。
    //
    // ⚠️ 这里绝不能用 findMany + distinct 全表拉：user_merchants 有 162 万行（存活 147 万），
    // Prisma 的 distinct 是在应用层去重的，会把整表搬进 Node 内存；实测光库内全表
    // GROUP BY platform,merchant_id 就要 24 秒，服务器只有 3.7G 内存，必然出事。
    // 改成只查上一步真正有订单的那批 MID（约 3300 个），EXPLAIN 确认走 idx_merchant_platform
    // 的 ref 扫描（每 MID 约 6 行），实测 13.7 秒出 3896 行。全接口约 17 秒，故 maxDuration 给 60。
    const mids = [...new Set(txnRows.map((t) => t.merchant_id))];
    const metaRows: MetaRow[] = mids.length
      ? await prisma.$queryRawUnsafe<MetaRow[]>(
          `SELECT platform, merchant_id,
                  MAX(merchant_url) AS merchant_url,
                  MAX(merchant_name) AS merchant_name
             FROM user_merchants
            WHERE is_deleted = 0 AND merchant_id IN (${mids.map(() => "?").join(",")})
            GROUP BY platform, merchant_id`,
          ...mids,
        )
      : [];
    const metaByKey = new Map<string, { domain: string; name: string | null }>();
    for (const m of metaRows) {
      metaByKey.set(`${m.platform}|${m.merchant_id}`, {
        domain: toDomain(m.merchant_url),
        name: m.merchant_name,
      });
    }

    const adsByKey = new Map<string, AdsRow>();
    for (const a of adsRows) adsByKey.set(`${a.platform}|${a.merchant_id}`, a);

    // ── 4) 合并。以佣金侧为主表：有订单的才是这个接口关心的对象。
    const merchants = [];
    for (const t of txnRows) {
      const key = `${t.platform}|${t.merchant_id}`;
      const ordersOk = num(t.orders_ok);
      const isVerified = ordersOk > 0;
      if (verifiedOnly && !isVerified) continue;

      const commissionOk = num(t.commission_ok);
      const ads = adsByKey.get(key);
      const clicks = num(ads?.clicks);
      const cost = num(ads?.cost);
      const meta = metaByKey.get(key);

      // 订单/点击比。>1 意味着订单根本不是这些点击带来的——佣金分子含了非 Google Ads 流量，
      // 而分母只有广告点击，breakeven_cpc 因此被系统性高估。
      // 本想改用「只算能归因到系列的佣金」来修，实测 affiliate_transactions.campaign_id
      // 全库 468,856 笔里只填了 1 笔（0.0%），这条路走不通，只能如实标注可信度。
      const ordersPerClick = clicks > 0 ? ordersOk / clicks : null;
      const breakevenTrusted =
        ordersPerClick != null && ordersPerClick <= ORDERS_PER_CLICK_TRUST_MAX;

      merchants.push({
        merchant_id: t.merchant_id,
        // ⚠️ 联盟维度在 CRM 里叫 platform（Hermes 12.5c 原约定写的是 network，字段名以此为准）
        platform: t.platform,
        merchant_name: t.merchant_name || meta?.name || null,
        domain: meta?.domain || null,

        // ── 判决矩阵用（12.5a）
        team_verified: isVerified,
        verified_by_count: num(t.verified_by_count),
        first_order_date: t.first_order_at
          ? new Date(t.first_order_at).toISOString().slice(0, 10)
          : null,
        last_order_date: t.last_order_at
          ? new Date(t.last_order_at).toISOString().slice(0, 10)
          : null,
        total_orders: ordersOk,
        total_orders_incl_rejected: num(t.orders_all),

        // ── CPC 限额用（12.5f）
        // breakeven_cpc = 有效佣金 ÷ 点击：每个点击能赚回多少。出价上限 = 它 × 安全系数。
        // 没有广告数据（别人不是靠 CRM 投的，或还没投）时给 null，调用方须走探测下限而不是当 0。
        breakeven_cpc: clicks > 0 ? r(commissionOk / clicks, 4) : null,
        // 「这个 breakeven_cpc 能不能直接乘安全系数当出价上限」——false 时分子含非广告流量，
        // 调用方应改用更严的系数或退回探测下限。实测有点击的 611 家里 345 家为 false。
        breakeven_trusted: clicks > 0 ? breakevenTrusted : null,
        orders_per_click: ordersPerClick != null ? r(ordersPerClick, 3) : null,
        weighted_cpc: clicks > 0 ? r(cost / clicks, 4) : null,
        total_clicks: clicks,
        total_cost: r(cost, 2),
        total_commission: r(commissionOk, 2),
        rejected_commission: r(num(t.commission_rejected), 2),
        per_order_commission: ordersOk > 0 ? r(commissionOk / ordersOk, 2) : null,
        avg_roi: cost > 0 ? r((commissionOk - cost) / cost, 4) : null,
        campaigns_ran: num(ads?.campaigns),
        users_ran: num(ads?.users_ran),
      });
    }

    // 让调用方一眼能挑出「最值得抢」的：盈亏平衡 CPC 高的在前，没有广告数据的垫底
    merchants.sort((a, b) => (b.breakeven_cpc ?? -1) - (a.breakeven_cpc ?? -1));

    const withBreakeven = merchants.filter((m) => m.breakeven_cpc != null);
    return apiSuccess({
      generated_at: new Date().toISOString(),
      since: since || null,
      // 口径写进响应，免得调用方拿去跟别处的数对不上时无从查证
      basis: {
        commission: "affiliate_transactions，排除 status=rejected 与 is_deleted=1",
        clicks_cost: "ads_daily_stats（is_deleted=0）经 user_merchants 归到 platform+merchant_id",
        breakeven_cpc: "有效佣金 ÷ 点击；无广告数据时为 null，调用方应走探测下限而非当 0",
        aggregate_key: "platform + merchant_id（同一 MID 在不同联盟是不同商家）",
        caveat_window:
          "佣金按 transaction_time、点击按 date；转化有延迟，since 收得越窄 breakeven_cpc 越偏低",
        caveat_attribution:
          `breakeven_trusted=false 表示订单/点击比 > ${ORDERS_PER_CLICK_TRUST_MAX}，` +
          "佣金分子含非广告流量而分母只有广告点击，该值偏高。" +
          "根因是 affiliate_transactions.campaign_id 全库填充率 0.0%，无法做系列级归因",
        caveat_coverage:
          "有订单的商家里仅约 20% 在 CRM 有广告数据，其余 breakeven_cpc 为 null，" +
          "只能用 team_verified 这个布尔信号",
      },
      counts: {
        merchants: merchants.length,
        verified: merchants.filter((m) => m.team_verified).length,
        with_breakeven: withBreakeven.length,
        breakeven_trusted: withBreakeven.filter((m) => m.breakeven_trusted).length,
        breakeven_ge_1usd: withBreakeven.filter((m) => (m.breakeven_cpc ?? 0) >= 1).length,
        with_domain: merchants.filter((m) => m.domain).length,
      },
      merchants,
    });
  } catch (err) {
    console.error("[HermesTeamVerified] GET 异常:", err);
    return apiError("获取团队已验证商家失败", 500);
  }
}
