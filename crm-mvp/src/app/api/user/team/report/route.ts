import { NextRequest } from "next/server";
import { apiSuccess, apiError } from "@/lib/constants";
import { withLeader } from "@/lib/api-handler";
import prisma from "@/lib/prisma";

export const dynamic = "force-dynamic";

/**
 * GET /api/user/team/report?year=2026
 *
 * 生成组长年度收支报表数据，格式对齐「2026年度丰度1-12月份收支统计表」。
 * 返回：
 *   - members[]：团队成员列表
 *   - platforms[]：参与统计的平台列表
 *   - data[month][userId][platform] = { total, rejected, active }
 *   - adSpend[month][userId] = cost
 */
export const GET = withLeader(async (req: NextRequest, { user }) => {
  const { searchParams } = new URL(req.url);
  const year = parseInt(searchParams.get("year") || String(new Date().getFullYear()), 10);
  if (isNaN(year) || year < 2020 || year > 2100) return apiError("无效年份");

  if (!user.teamId) return apiError("未关联小组");
  const teamId = BigInt(user.teamId);

  // ── 1. 获取团队成员 ────────────────────────────────────────────────
  const members = await prisma.users.findMany({
    where: { team_id: teamId, is_deleted: 0, role: "user" },
    select: { id: true, username: true, display_name: true },
    orderBy: { username: "asc" },
  });
  if (members.length === 0) return apiSuccess({ members: [], platforms: [], data: {}, adSpend: {} });

  const memberIds = members.map((m) => m.id);
  const yearStart = `${year}-01-01`;
  const yearEnd = `${year + 1}-01-01`;

  // ── 2. 佣金数据：按用户/月份/平台聚合 ────────────────────────────
  const commRows = await prisma.$queryRawUnsafe<{
    user_id: bigint;
    month: string;
    platform: string;
    total_commission: number;
    rejected_commission: number;
  }[]>(`
    SELECT
      user_id,
      DATE_FORMAT(CONVERT_TZ(transaction_time, '+00:00', '+08:00'), '%Y-%m') AS month,
      platform,
      SUM(CAST(commission_amount AS DECIMAL(14,4)))                                          AS total_commission,
      SUM(CASE WHEN status = 'rejected' THEN CAST(commission_amount AS DECIMAL(14,4)) ELSE 0 END) AS rejected_commission
    FROM affiliate_transactions
    WHERE user_id IN (${memberIds.map(() => "?").join(",")})
      AND is_deleted = 0
      AND transaction_time >= ? AND transaction_time < ?
    GROUP BY user_id, month, platform
    ORDER BY user_id, month, platform
  `, ...memberIds, yearStart, yearEnd);

  // ── 3. 广告费：按用户/月份聚合 ────────────────────────────────────
  const spendRows = await prisma.$queryRawUnsafe<{
    user_id: bigint;
    month: string;
    cost: number;
  }[]>(`
    SELECT
      user_id,
      DATE_FORMAT(date, '%Y-%m') AS month,
      SUM(CAST(cost AS DECIMAL(14,4))) AS cost
    FROM ads_daily_stats
    WHERE user_id IN (${memberIds.map(() => "?").join(",")})
      AND date >= ? AND date < ?
    GROUP BY user_id, month
    ORDER BY user_id, month
  `, ...memberIds, yearStart, yearEnd);

  // ── 4. 整理平台列表（按出现频率排序，固定顺序） ──────────────────
  const PLATFORM_ORDER = ["RW", "LH", "CG", "LB", "PM", "CF", "BSH", "MUI", "EV", "AD"];
  const platformSet = new Set(commRows.map((r) => r.platform));
  const platforms = PLATFORM_ORDER.filter((p) => platformSet.has(p));
  // 补充其余未在固定顺序中的平台
  for (const p of platformSet) { if (!platforms.includes(p)) platforms.push(p); }

  // ── 5. 构建 data 结构：data[month][userId][platform] ─────────────
  type PlatformStat = { total: number; rejected: number; active: number };
  type MonthData = Record<string, Record<string, PlatformStat>>;
  const data: MonthData = {};

  for (const row of commRows) {
    const uid = String(row.user_id);
    const m = row.month;
    const p = row.platform;
    const total = Number(row.total_commission || 0);
    const rejected = Number(row.rejected_commission || 0);
    if (!data[m]) data[m] = {};
    if (!data[m][uid]) data[m][uid] = {};
    data[m][uid][p] = { total, rejected, active: total - rejected };
  }

  // ── 6. 构建 adSpend 结构：adSpend[month][userId] ─────────────────
  const adSpend: Record<string, Record<string, number>> = {};
  for (const row of spendRows) {
    const uid = String(row.user_id);
    const m = row.month;
    const cost = Number(row.cost || 0);
    if (!adSpend[m]) adSpend[m] = {};
    adSpend[m][uid] = cost;
  }

  // ── 7. 生成完整月份列表（1-12月） ────────────────────────────────
  const months = Array.from({ length: 12 }, (_, i) => `${year}-${String(i + 1).padStart(2, "0")}`);

  return apiSuccess({
    year,
    members: members.map((m) => ({
      id: String(m.id),
      username: m.username,
      display_name: m.display_name || m.username,
    })),
    platforms,
    months,
    data,
    adSpend,
  });
});
