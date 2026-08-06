import { NextRequest } from "next/server";
import { apiSuccess, apiError } from "@/lib/constants";
import prisma from "@/lib/prisma";
import { verifyHermesToken } from "@/lib/hermes-auth";

// D-219 / Hermes HM-D69：广告系列级真实业绩快照（按 Google campaign id 精确取数）。
//
// 为什么要有这个接口：Hermes 的 auto-tune 要按盈亏比决定加不加预算、抬不抬价，可它自己
// 那套 click_token 归因只有 4% 的命中率（见 Hermes 设计方案 12.7），拿不到系列级佣金，
// 只能退而用「商家 + 联盟」把同一商家所有广告的佣金合并成一个数去代表其中每一条。
// 一个商家只有一条广告时这么算没问题；有多条时就会串味。实测 #46 mmlafleur：合并口径
// 算出 278 单、盈亏比 16.98，系列级实际只有 125 单、盈亏比 10.25——按公式反推出价，
// 前者给 $1.36、后者给 $0.82，差 66%，等于会把价抬过头一大截。
//
// 而 CRM 这边是有系列级归因的：ads_daily_stats 按 campaign_id 存了每天的佣金/订单/拒付，
// 全库 10.2 万行里 4.5 万行有佣金。⚠️ 注意别被 /api/hermes/team-verified-merchants 里那句
// 「affiliate_transactions.campaign_id 填充率 0.0%，做不了系列级归因」误导——归因结果不在
// 那张表的 campaign_id 列上，而是在 ads_daily_stats 里，那句话说的是另一条路。
//
// 只读、不写库。Hermes 端整表替换 + 本地快照兜底（接口不可达时用上一份）。

export const dynamic = "force-dynamic";
export const maxDuration = 60;

const num = (v: unknown): number => {
  const n = Number(v ?? 0);
  return Number.isFinite(n) ? n : 0;
};
const r = (v: number, n: number): number => {
  const p = 10 ** n;
  return Math.round(v * p) / p;
};

// 订单比点击还多，说明这条系列的佣金里混进了非广告流量（商家自然单被归到了系列上）。
// 实测团队库里 688-LH1-viagogo 是 0 点击对 1712 单、529-LH1-stubhubsports 是 273 点击对
// 1483 单——拿这种数算盈亏比会得出几百倍甚至无穷大。取 1.0 而不是 team-verified 那边的 0.3：
// 那个接口聚的是「商家在所有渠道的佣金 ÷ 广告点击」，天然偏高；这里分子分母同属一条系列，
// 只有真串了流量才会超过 1。
const ORDERS_PER_CLICK_TRUST_MAX = 1.0;

// 点击太少时各项均值都没有统计意义。与 team-verified-merchants 同口径。
const MIN_CLICKS_FOR_STATS = 30;

type StatsQuality =
  | "trusted" // 样本够且订单/点击正常 → 可直接用于调价
  | "inflated" // 佣金含非广告流量 → 盈亏比虚高，不可用于抬价
  | "thin_sample" // 点击 <30 → 数值无统计意义，只可用于止损不可用于加码
  | "no_data"; // CRM 里查不到这条系列（刚发布还没同步，或已被删）

type Row = {
  gcid: string;
  campaign_name: string | null;
  customer_id: string | null;
  max_cpc_limit: string | number | null;
  daily_budget: string | number | null;
  clicks: bigint | number | null;
  cost: string | number | null;
  orders: bigint | number | null;
  commission: string | number | null;
  rejected_commission: string | number | null;
  first_date: Date | string | null;
  last_date: Date | string | null;
  days: bigint | number | null;
};

export async function POST(req: NextRequest) {
  const authErr = verifyHermesToken(req);
  if (authErr) return authErr;

  let gcids: string[] = [];
  try {
    const body = await req.json();
    gcids = Array.isArray(body?.gcids) ? body.gcids.map(String).filter(Boolean) : [];
  } catch {
    return apiError("请求体必须是 JSON，形如 { gcids: [\"24019301237\", ...] }", 400);
  }
  if (!gcids.length) return apiError("gcids 不能为空", 400);
  // 上限保护：Hermes 目前 431 条已发布系列，留足余量但别让人一次拉全库
  if (gcids.length > 2000) return apiError("单次最多 2000 个 gcid", 400);

  const uniq = [...new Set(gcids)];

  try {
    // campaigns.google_campaign_id 上有索引（MUL），走 ref 扫描。
    // ⚠️ 用 LEFT JOIN 而不是 INNER：系列建了但一天数据都还没同步时也要能返回一行，
    // 让调用方能区分「查不到这条系列」和「查到了但还没有数据」。
    const rows = await prisma.$queryRawUnsafe<Row[]>(
      `SELECT c.google_campaign_id           AS gcid,
              c.campaign_name                AS campaign_name,
              c.customer_id                  AS customer_id,
              c.max_cpc_limit                AS max_cpc_limit,
              c.daily_budget                 AS daily_budget,
              COALESCE(SUM(s.clicks), 0)     AS clicks,
              ROUND(COALESCE(SUM(CAST(s.cost AS DECIMAL(16,6))), 0), 6) AS cost,
              COALESCE(SUM(s.orders), 0)     AS orders,
              ROUND(COALESCE(SUM(CAST(s.commission AS DECIMAL(14,4))), 0), 4) AS commission,
              ROUND(COALESCE(SUM(CAST(s.rejected_commission AS DECIMAL(14,4))), 0), 4) AS rejected_commission,
              MIN(s.date)                    AS first_date,
              MAX(s.date)                    AS last_date,
              COUNT(s.id)                    AS days
         FROM campaigns c
         LEFT JOIN ads_daily_stats s ON s.campaign_id = c.id AND s.is_deleted = 0
        WHERE c.is_deleted = 0
          AND c.google_campaign_id IN (${uniq.map(() => "?").join(",")})
        GROUP BY c.id`,
      ...uniq,
    );

    const byGcid = new Map<string, Row>();
    for (const row of rows) byGcid.set(String(row.gcid), row);

    const campaigns = uniq.map((gcid) => {
      const row = byGcid.get(gcid);
      // 查不到也要给出完整形状：调用方按字段名取值，缺字段会让它在 undefined 上做算术，
      // 静默算出 NaN 再拿去调价，比直接返回 null 危险得多
      if (!row) {
        return {
          gcid,
          found: false,
          campaign_name: null,
          customer_id: null,
          crm_max_cpc_limit: null,
          crm_daily_budget: null,
          clicks: 0,
          cost: 0,
          orders: 0,
          commission: 0,
          rejected_commission: 0,
          effective_commission: 0,
          profit_ratio: null,
          per_order_commission: null,
          per_order_commission_net: null,
          clicks_per_order: null,
          avg_cpc: null,
          breakeven_cpc: null,
          reject_rate: null,
          orders_per_click: null,
          quality: "no_data" as StatsQuality,
          first_date: null,
          last_date: null,
          days: 0,
        };
      }
      const clicks = num(row.clicks);
      const cost = num(row.cost);
      const orders = num(row.orders);
      const commission = num(row.commission);
      const rejected = num(row.rejected_commission);
      // 净佣金 = 全状态佣金 − 已拒付。07 的口径：待定不打折，拒付才扣（见 Hermes 12.7）
      const effective = commission - rejected;

      const ordersPerClick = clicks > 0 ? orders / clicks : null;
      let quality: StatsQuality;
      if (clicks <= 0) quality = orders > 0 ? "inflated" : "no_data";
      else if (ordersPerClick! > ORDERS_PER_CLICK_TRUST_MAX) quality = "inflated";
      else if (clicks < MIN_CLICKS_FOR_STATS) quality = "thin_sample";
      else quality = "trusted";

      return {
        gcid,
        found: true,
        campaign_name: row.campaign_name,
        customer_id: row.customer_id,
        // CRM 侧记录的出价上限/日预算，供 Hermes 核对两边有没有走岔
        crm_max_cpc_limit: row.max_cpc_limit != null ? num(row.max_cpc_limit) : null,
        crm_daily_budget: row.daily_budget != null ? num(row.daily_budget) : null,

        clicks,
        cost: r(cost, 2),
        orders,
        commission: r(commission, 2),
        rejected_commission: r(rejected, 2),
        effective_commission: r(effective, 2),

        // ── 决策直接要用的派生量（口径见 basis）
        // 盈亏比：净佣金 ÷ 花费。>1 回本，07 定的加码线是 1.5、抬价线是 2×(1+拒付率)
        profit_ratio: cost > 0 ? r(effective / cost, 4) : null,
        // 每单佣金（07 口径的 AOV）
        per_order_commission: orders > 0 ? r(commission / orders, 2) : null,
        per_order_commission_net: orders > 0 ? r(effective / orders, 2) : null,
        // 多少个点击换一单
        clicks_per_order: orders > 0 && clicks > 0 ? r(clicks / orders, 2) : null,
        // 实付均价。抬价公式按它乘，而不是按现上限乘——上限 $2 实付 $0.19 的广告
        // 按上限翻倍会直接跳到 $4，等于把没验证过的价格一次性放出去
        avg_cpc: clicks > 0 ? r(cost / clicks, 4) : null,
        // 盈亏平衡 CPC：这条系列每个点击能赚回多少净佣金
        breakeven_cpc: clicks > 0 ? r(effective / clicks, 4) : null,
        reject_rate: commission > 0 ? r(rejected / commission, 4) : null,
        orders_per_click: ordersPerClick != null ? r(ordersPerClick, 4) : null,

        quality,
        first_date: row.first_date ? new Date(row.first_date).toISOString().slice(0, 10) : null,
        last_date: row.last_date ? new Date(row.last_date).toISOString().slice(0, 10) : null,
        days: num(row.days),
      };
    });

    const found = campaigns.filter((c) => c.found);
    const byQuality = campaigns.reduce<Record<string, number>>((acc, c) => {
      acc[c.quality] = (acc[c.quality] || 0) + 1;
      return acc;
    }, {});

    return apiSuccess({
      generated_at: new Date().toISOString(),
      basis: {
        source: "ads_daily_stats（is_deleted=0）按 campaigns.google_campaign_id 聚合，全期不设窗口",
        commission: "全状态佣金（含待定），与 CRM 数据中心「佣金」列同口径；待定不打折",
        effective_commission: "佣金 − 已拒付。07 口径：净利润 = 佣金 − 拒付 − 成本",
        profit_ratio: "净佣金 ÷ 花费（等价于 AOV ÷ 获客成本）",
        avg_cpc: "花费 ÷ 点击，即实付均价，不是出价上限",
        quality: {
          trusted: `点击 ≥${MIN_CLICKS_FOR_STATS} 且订单/点击 ≤${ORDERS_PER_CLICK_TRUST_MAX}，可用于调价`,
          inflated: `订单/点击 >${ORDERS_PER_CLICK_TRUST_MAX}，佣金含非广告流量、盈亏比虚高，不可用于抬价`,
          thin_sample: `点击 <${MIN_CLICKS_FOR_STATS}，数值无统计意义，只可用于止损不可用于加码`,
          no_data: "CRM 查不到该系列（刚发布还没同步，或已被删）",
        },
        caveat_freshness:
          "CRM 的广告数据靠定时同步，last_date 可能落后当天；刚发布的系列通常要等下一轮同步才出现",
      },
      counts: {
        requested: uniq.length,
        found: found.length,
        missing: uniq.length - found.length,
        by_quality: byQuality,
        with_orders: found.filter((c) => (c.orders ?? 0) > 0).length,
      },
      campaigns,
    });
  } catch (err) {
    console.error("[HermesCampaignStats] POST 异常:", err);
    return apiError("获取广告系列业绩失败", 500);
  }
}
