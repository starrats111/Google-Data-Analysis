import { NextRequest } from "next/server";
import { apiSuccess, apiError } from "@/lib/constants";
import prisma from "@/lib/prisma";
import { verifyHermesToken } from "@/lib/hermes-auth";

// HM-D48：商家情报只读快照 —— 供 Hermes 每天同步一次，落到它本地 SQLite 做选品门槛。
// 07 的《选商家 SOP》阶段二要看「标签违规 / 拒付率 / ATC 竞争度」三项，这三项数据都在 CRM，
// Hermes 那台机器连不上 CRM 的库（只监听 127.0.0.1），所以走这个接口发一份快照过去。
// 只读、不写库；量级约 3-4 千行，一次全量返回，Hermes 端整表替换。

export const dynamic = "force-dynamic";
export const maxDuration = 60;

/** URL → 裸域名（与 Hermes 的 normalizeDomain 口径对齐：去协议、去 www、去路径、小写） */
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

export async function GET(req: NextRequest) {
  const authErr = verifyHermesToken(req);
  if (authErr) return authErr;

  const url = new URL(req.url);
  // 拒付率时间窗与 CRM 拒付商家页保持同一口径（§19.6.8），默认 2025-11-01 起算
  const since = url.searchParams.get("since") || "2025-11-01";

  try {
    // 1) 政策标签：Google 广告的受限/禁投品类（大麻、烟草、武器、成人、医疗、金融…）
    //    同一个商家在多个用户名下会有多行，按域名去重取最严的那档
    const policyRows = await prisma.user_merchants.findMany({
      where: { is_deleted: 0, policy_status: { in: ["restricted", "prohibited"] } },
      select: {
        merchant_name: true,
        merchant_url: true,
        platform: true,
        merchant_id: true,
        policy_status: true,
        policy_category_code: true,
      },
    });
    const policyByDomain = new Map<string, {
      domain: string; merchant_name: string; platform: string; merchant_id: string;
      policy_status: string; category: string | null;
    }>();
    for (const r of policyRows) {
      const domain = toDomain(r.merchant_url);
      if (!domain) continue;
      const cur = policyByDomain.get(domain);
      // prohibited 比 restricted 严，同域名两种都有时留 prohibited
      if (cur && !(r.policy_status === "prohibited" && cur.policy_status !== "prohibited")) continue;
      policyByDomain.set(domain, {
        domain,
        merchant_name: r.merchant_name,
        platform: r.platform,
        merchant_id: r.merchant_id,
        policy_status: r.policy_status,
        category: r.policy_category_code,
      });
    }

    const categories = await prisma.ad_policy_categories.findMany({
      where: { is_deleted: 0 },
      select: { category_code: true, category_name: true, restriction_level: true },
    });

    // 2) 拒付率：按佣金金额算（不是按笔数），分母含全部状态，与拒付商家页同一条 SQL 口径
    const chargebackRows = await prisma.$queryRawUnsafe<Array<{
      platform: string; merchant_id: string; merchant_name: string;
      orders: bigint | number; total_all: string | number | null; rate: string | number | null;
    }>>(
      `SELECT platform, merchant_id, MAX(merchant_name) AS merchant_name,
              COUNT(*) AS orders,
              ROUND(SUM(CAST(commission_amount AS DECIMAL(14,4))), 2) AS total_all,
              ROUND(SUM(CASE WHEN status = 'rejected' THEN CAST(commission_amount AS DECIMAL(14,4)) ELSE 0 END)
                    / NULLIF(SUM(CAST(commission_amount AS DECIMAL(14,4))), 0) * 100, 2) AS rate
       FROM affiliate_transactions
       WHERE is_deleted = 0 AND transaction_time >= ?
       GROUP BY platform, merchant_id
       HAVING orders >= 10
       ORDER BY rate DESC`,
      since,
    );

    // 拒付率是按 platform+merchant_id 聚出来的，Hermes 那边主要按域名匹配，这里补一张映射
    const merchantUrls = await prisma.user_merchants.findMany({
      where: { is_deleted: 0, merchant_url: { not: null } },
      select: { platform: true, merchant_id: true, merchant_url: true },
      distinct: ["platform", "merchant_id"],
    });
    const urlByKey = new Map<string, string>();
    for (const m of merchantUrls) {
      const d = toDomain(m.merchant_url);
      if (d) urlByKey.set(`${m.platform}|${m.merchant_id}`, d);
    }

    // 3) ATC 竞争度：团队共享快照（谁查过都能用），Hermes 查不到的自己现调 SerpApi
    const atc = await prisma.merchant_atc_snapshots.findMany({
      select: {
        domain: true, region: true,
        real_advertiser_count: true, raw_advertiser_count: true,
        fetched_at: true,
      },
    });

    return apiSuccess({
      since,
      generated_at: new Date().toISOString(),
      policy: [...policyByDomain.values()],
      policy_categories: categories,
      chargeback: chargebackRows.map((r) => ({
        platform: r.platform,
        merchant_id: r.merchant_id,
        merchant_name: r.merchant_name,
        domain: urlByKey.get(`${r.platform}|${r.merchant_id}`) || null,
        orders: Number(r.orders),
        total_commission: Number(r.total_all || 0),
        rate_pct: Number(r.rate || 0),
      })),
      atc: atc.map((a) => ({
        domain: a.domain,
        region: a.region,
        real_advertiser_count: a.real_advertiser_count,
        raw_advertiser_count: a.raw_advertiser_count,
        fetched_at: a.fetched_at?.toISOString() || null,
      })),
      counts: {
        policy: policyByDomain.size,
        chargeback: chargebackRows.length,
        atc: atc.length,
      },
    });
  } catch (err) {
    console.error("[HermesIntel] GET 异常:", err);
    return apiError("获取商家情报失败", 500);
  }
}
