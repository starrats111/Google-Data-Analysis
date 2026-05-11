import { NextRequest } from "next/server";
import { apiSuccess, apiError, PLATFORMS } from "@/lib/constants";
import { withUser } from "@/lib/api-handler";
import prisma from "@/lib/prisma";

// C-019 R1.2：全员拒付商家聚合（见设计方案 §19.6.3 + §19.6.7 + §19.6.8）
// 非按 user_id 过滤 —— 所有登录用户平权见同一份全员数据（07 决议 ⑥）
// R1.2 口径：拒付率 = rejected / SUM(commission_amount){全部状态}（§19.6.8）

const DEFAULT_DATE_START = "2025-11-01";
const VALID_PLATFORMS = new Set<string>(PLATFORMS.map((p) => p.code));

function isValidDate(s: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(s) && !isNaN(Date.parse(s));
}

export const GET = withUser(async (req: NextRequest) => {
  const url = req.nextUrl;
  const dateStartRaw = (url.searchParams.get("date_start") || DEFAULT_DATE_START).trim();
  const dateEndRaw = (url.searchParams.get("date_end") || new Date().toISOString().slice(0, 10)).trim();
  const thresholdRaw = url.searchParams.get("threshold");
  const platformRaw = (url.searchParams.get("platform") || "").trim();
  const searchRaw = (url.searchParams.get("search") || "").trim();

  if (!isValidDate(dateStartRaw)) return apiError("date_start 格式应为 YYYY-MM-DD");
  if (!isValidDate(dateEndRaw)) return apiError("date_end 格式应为 YYYY-MM-DD");
  if (dateEndRaw < dateStartRaw) return apiError("date_end 不能早于 date_start");

  let threshold = 50;
  if (thresholdRaw !== null && thresholdRaw !== "") {
    const n = Number(thresholdRaw);
    if (isNaN(n) || n < 0 || n > 100) return apiError("threshold 取值范围应为 0–100");
    threshold = n;
  }

  const platformClause = platformRaw ? " AND platform = ?" : "";
  if (platformRaw && !VALID_PLATFORMS.has(platformRaw)) return apiError("platform 不合法");

  let searchClause = "";
  const searchParams: string[] = [];
  if (searchRaw) {
    searchClause = " AND (merchant_name LIKE ? OR merchant_id LIKE ?)";
    const like = `%${searchRaw}%`;
    searchParams.push(like, like);
  }

  const params: unknown[] = [dateStartRaw, dateEndRaw];
  if (platformRaw) params.push(platformRaw);
  params.push(...searchParams);
  params.push(threshold);

  const sql = `
    SELECT
      platform,
      merchant_id,
      MAX(merchant_name)                                                       AS merchant_name,
      COUNT(*)                                                                 AS orders,
      ROUND(SUM(CAST(commission_amount AS DECIMAL(14,4))), 2)                  AS total_all,
      ROUND(SUM(CASE WHEN status IN ('approved','rejected')
                     THEN CAST(commission_amount AS DECIMAL(14,4)) ELSE 0 END), 2) AS total_settled,
      ROUND(SUM(CASE WHEN status = 'rejected'
                     THEN CAST(commission_amount AS DECIMAL(14,4)) ELSE 0 END), 2) AS rejected,
      -- R1.2：分母改为 SUM(commission_amount) 全部状态（§19.6.8）
      ROUND(
        SUM(CASE WHEN status = 'rejected' THEN CAST(commission_amount AS DECIMAL(14,4)) ELSE 0 END)
        / NULLIF(SUM(CAST(commission_amount AS DECIMAL(14,4))), 0) * 100,
        2
      ) AS rate
    FROM affiliate_transactions
    WHERE is_deleted = 0
      AND transaction_time >= ?
      AND transaction_time < DATE_ADD(?, INTERVAL 1 DAY)
      ${platformClause}
      ${searchClause}
    GROUP BY platform, merchant_id
    HAVING rate >= ?
    ORDER BY rate DESC, total_all DESC
    LIMIT 1000
  `;

  const rows = await prisma.$queryRawUnsafe<Array<{
    platform: string;
    merchant_id: string;
    merchant_name: string;
    orders: number | bigint;
    total_all: number | string | null;
    total_settled: number | string | null;
    rejected: number | string | null;
    rate: number | string | null;
  }>>(sql, ...params);

  const data = rows.map((r) => ({
    platform: r.platform,
    merchant_id: r.merchant_id,
    merchant_name: r.merchant_name,
    orders: Number(r.orders || 0),
    total_all: Number(r.total_all || 0),
    total_settled: Number(r.total_settled || 0),
    rejected: Number(r.rejected || 0),
    rate: Number(r.rate || 0),
  }));

  return apiSuccess({
    items: data,
    total: data.length,
    date_start: dateStartRaw,
    date_end: dateEndRaw,
    threshold,
    platform: platformRaw || null,
    search: searchRaw || null,
  });
});
