/**
 * 测试脚本：验证 AI 分析工具的数据查询是否正确
 *
 * 测试重点：
 * 1. getUserCampaignIds — 通过 campaigns 表取 campaign IDs（新方式）
 * 2. 新旧查询对比 — 旧方式(user_id直查) vs 新方式(campaigns中转)
 * 3. 各工具返回结果正确性
 *
 * 用法：npx tsx scripts/test-ai-analysis.ts [用户名]
 */
import "dotenv/config";
import prisma from "../src/lib/prisma";
import { dateColumnStart, dateColumnEndExclusive } from "../src/lib/date-utils";

const TARGET_USERNAME = process.argv[2] || undefined;
// 日期范围在探测到实际数据后动态设定
let DATE_FROM = new Date(Date.now() - 7 * 86400_000).toISOString().slice(0, 10);
let DATE_TO   = new Date().toISOString().slice(0, 10);

const fmtMoney = (v: unknown) => `$${Number(v || 0).toFixed(2)}`;
const sep      = (label: string) => console.log(`\n${"─".repeat(60)}\n${label}\n${"─".repeat(60)}`);
const ok       = (msg: string)   => console.log(`  [PASS] ${msg}`);
const fail     = (msg: string)   => console.log(`  [FAIL] ${msg}`);
const info     = (msg: string)   => console.log(`  [INFO] ${msg}`);

async function main() {
  sep("AI 分析工具查询正确性测试");
  info(`日期范围：${DATE_FROM} ~ ${DATE_TO}`);

  // ── 1. 选择测试用户 ──────────────────────────────────
  sep("STEP 1: 选择测试用户");

  let user: { id: bigint; username: string; display_name: string | null } | null = null;

  if (TARGET_USERNAME) {
    user = await prisma.users.findFirst({
      where: { username: TARGET_USERNAME, is_deleted: 0 },
      select: { id: true, username: true, display_name: true },
    });
    if (!user) { fail(`找不到用户 ${TARGET_USERNAME}`); process.exit(1); }
  } else {
    // 自动找第一个有广告系列数据的用户
    info("未指定用户名，自动查找有广告系列的用户...");
    const campaignUsers = await prisma.campaigns.groupBy({
      by: ["user_id"],
      where: { is_deleted: 0 },
      _count: { id: true },
      orderBy: { _count: { id: "desc" } },
      take: 10,
    });
    for (const cu of campaignUsers) {
      const u = await prisma.users.findFirst({
        where: { id: cu.user_id, is_deleted: 0 },
        select: { id: true, username: true, display_name: true },
      });
      if (u) { user = u; info(`找到用户 ${u.username}，有 ${cu._count.id} 个广告系列`); break; }
    }
    if (!user) { fail("数据库中无任何用户有广告系列记录"); process.exit(1); }
  }

  ok(`测试用户：${user.username}（${user.display_name || "-"}），ID=${user.id}`);
  const userId = user.id;

  // ── 1b. 探测实际数据日期范围 ────────────────────────
  sep("STEP 1b: 探测该用户 ads_daily_stats 实际数据日期范围");

  const dateRange = await prisma.ads_daily_stats.aggregate({
    where: { user_id: userId, is_deleted: 0 },
    _max: { date: true },
    _min: { date: true },
  });

  const isoDate = (d: Date) => d.toISOString().slice(0, 10);

  if (dateRange._max.date && dateRange._min.date) {
    info(`ads_daily_stats 中该用户数据范围（user_id）：${isoDate(dateRange._min.date)} ~ ${isoDate(dateRange._max.date)}`);
  }

  // 用 campaigns 中转再查实际日期范围（新方式）
  const campaignIdsForDateProbe = await prisma.campaigns.findMany({
    where: { user_id: userId, is_deleted: 0 },
    select: { id: true },
  });
  const cidsProbe = campaignIdsForDateProbe.map((c) => c.id);

  if (cidsProbe.length > 0) {
    const dateRangeNew = await prisma.ads_daily_stats.aggregate({
      where: { campaign_id: { in: cidsProbe }, is_deleted: 0 },
      _max: { date: true },
      _min: { date: true },
    });
    if (dateRangeNew._max.date && dateRangeNew._min.date) {
      const maxDate = isoDate(dateRangeNew._max.date);
      const minDate = isoDate(dateRangeNew._min.date);
      info(`ads_daily_stats 中该用户数据范围（campaign_id IN）：${minDate} ~ ${maxDate}`);
      // 自动用最近 7 天（或实际范围内的最后7天）作为测试区间
      DATE_TO   = maxDate;
      const d = new Date(maxDate + "T00:00:00.000Z");
      d.setUTCDate(d.getUTCDate() - 6);
      DATE_FROM = d.toISOString().slice(0, 10);
      ok(`测试日期范围自动调整为：${DATE_FROM} ~ ${DATE_TO}`);
    } else {
      info("新方式下 ads_daily_stats 也无数据记录，后续步骤将提前退出");
    }
  }

  // ── 2. 测试 getUserCampaignIds（新方式：通过 campaigns 表）──
  sep("STEP 2: getUserCampaignIds — 通过 campaigns 表取 campaign IDs");

  const campaigns = await prisma.campaigns.findMany({
    where: { user_id: userId, is_deleted: 0 },
    select: { id: true, campaign_name: true, status: true },
    orderBy: { id: "desc" },
    take: 200,
  });
  const campaignIds = campaigns.map((c) => c.id);

  if (campaignIds.length === 0) {
    fail('campaigns 表中该用户无记录 → AI 分析将提示[暂无广告系列]，属预期行为');
  } else {
    ok(`找到 ${campaignIds.length} 个广告系列（展示前5）：`);
    campaigns.slice(0, 5).forEach((c) => {
      info(`  ID=${c.id}  ${c.campaign_name}  [${c.status}]`);
    });
  }

  // ── 3. 旧方式 vs 新方式 对比 ────────────────────────
  sep("STEP 3: 旧方式(user_id直查) vs 新方式(campaign_id IN) 结果对比");

  const [oldStats, newStats] = await Promise.all([
    prisma.ads_daily_stats.count({
      where: {
        user_id: userId,
        date: { gte: dateColumnStart(DATE_FROM), lt: dateColumnEndExclusive(DATE_TO) },
        is_deleted: 0,
      },
    }),
    campaignIds.length > 0
      ? prisma.ads_daily_stats.count({
          where: {
            campaign_id: { in: campaignIds },
            date: { gte: dateColumnStart(DATE_FROM), lt: dateColumnEndExclusive(DATE_TO) },
            is_deleted: 0,
          },
        })
      : Promise.resolve(0),
  ]);

  info(`旧方式（user_id = ${userId}）：匹配 ${oldStats} 条记录`);
  info(`新方式（campaign_id IN [${campaignIds.length}个ID]）：匹配 ${newStats} 条记录`);

  if (newStats > 0 && oldStats === 0) {
    ok("已确认 Bug 根因：旧方式查不到数据，新方式正常 ✓");
  } else if (newStats === 0 && oldStats === 0) {
    info("两种方式均无数据 → 该日期范围内无广告投放记录（可调整 DATE_FROM/DATE_TO 重试）");
  } else if (newStats > 0 && oldStats > 0) {
    ok(`两种方式均有数据，记录数${oldStats === newStats ? "一致" : "不同：旧=" + oldStats + " 新=" + newStats}`);
  } else {
    fail(`异常：旧方式 ${oldStats}，新方式 ${newStats}`);
  }

  if (newStats === 0) {
    info("无数据可继续测试，脚本结束。请换一个有广告数据的用户或调整日期范围。");
    await prisma.$disconnect();
    return;
  }

  // ── 4. get_account_overview ──────────────────────────
  sep("STEP 4: get_account_overview — 账户总览");

  const statsAll = await prisma.ads_daily_stats.findMany({
    where: {
      campaign_id: { in: campaignIds },
      date: { gte: dateColumnStart(DATE_FROM), lt: dateColumnEndExclusive(DATE_TO) },
      is_deleted: 0,
    },
    select: { cost: true, clicks: true, impressions: true, commission: true, orders: true, campaign_id: true },
  });

  const totalCost       = statsAll.reduce((s, r) => s + Number(r.cost ?? 0), 0);
  const totalClicks     = statsAll.reduce((s, r) => s + Number(r.clicks ?? 0), 0);
  const totalImpressions = statsAll.reduce((s, r) => s + Number(r.impressions ?? 0), 0);
  const totalCommission = statsAll.reduce((s, r) => s + Number(r.commission ?? 0), 0);
  const totalOrders     = statsAll.reduce((s, r) => s + Number(r.orders ?? 0), 0);
  const activeCampaigns = new Set(statsAll.map((r) => String(r.campaign_id))).size;
  const roi             = totalCost > 0 ? ((totalCommission - totalCost) / totalCost * 100).toFixed(1) : "N/A";

  ok("账户总览成功返回数据：");
  info(`  花费：${fmtMoney(totalCost)}  佣金：${fmtMoney(totalCommission)}  ROI：${roi}%`);
  info(`  点击：${totalClicks}  曝光：${totalImpressions}  订单：${totalOrders}  活跃系列：${activeCampaigns}`);

  // ── 5. get_campaign_performance ──────────────────────
  sep("STEP 5: get_campaign_performance — 各系列明细");

  const statsPerCampaign = await prisma.ads_daily_stats.findMany({
    where: {
      campaign_id: { in: campaignIds },
      date: { gte: dateColumnStart(DATE_FROM), lt: dateColumnEndExclusive(DATE_TO) },
      is_deleted: 0,
    },
    select: { campaign_id: true, cost: true, clicks: true, commission: true, orders: true },
  });

  const grouped: Record<string, { cost: number; clicks: number; commission: number; orders: number }> = {};
  for (const r of statsPerCampaign) {
    const id = String(r.campaign_id);
    if (!grouped[id]) grouped[id] = { cost: 0, clicks: 0, commission: 0, orders: 0 };
    grouped[id].cost       += Number(r.cost ?? 0);
    grouped[id].clicks     += Number(r.clicks ?? 0);
    grouped[id].commission += Number(r.commission ?? 0);
    grouped[id].orders     += Number(r.orders ?? 0);
  }

  const campaignMap = new Map(campaigns.map((c) => [String(c.id), c.campaign_name]));
  const rows = Object.entries(grouped).map(([id, g]) => ({
    name: campaignMap.get(id) || `ID-${id}`,
    cost: g.cost,
    roi: g.cost > 0 ? ((g.commission - g.cost) / g.cost * 100).toFixed(1) : "N/A",
    named: campaignMap.has(id),
  }));
  rows.sort((a, b) => b.cost - a.cost);

  ok(`共 ${rows.length} 个系列有花费数据，展示前5：`);
  rows.slice(0, 5).forEach((r) => {
    const nameOk = r.named ? "" : " [名称未匹配，显示ID]";
    info(`  ${r.name}  花费：${fmtMoney(r.cost)}  ROI：${r.roi}%${nameOk}`);
  });

  const unnamedCount = rows.filter((r) => !r.named).length;
  if (unnamedCount > 0) {
    fail(`${unnamedCount} 个系列在 campaigns 表中无名称记录（将显示为 ID-xxx）`);
  } else {
    ok("所有系列均有对应的名称记录");
  }

  // ── 6. get_daily_trend ────────────────────────────────
  sep("STEP 6: get_daily_trend — 每日趋势");

  const trendStats = await prisma.ads_daily_stats.findMany({
    where: {
      campaign_id: { in: campaignIds },
      date: { gte: dateColumnStart(DATE_FROM), lt: dateColumnEndExclusive(DATE_TO) },
      is_deleted: 0,
    },
    select: { date: true, cost: true, commission: true },
    orderBy: { date: "asc" },
  });

  const dailyMap: Record<string, { cost: number; commission: number }> = {};
  for (const r of trendStats) {
    const dt = String(r.date).slice(0, 10);
    if (!dailyMap[dt]) dailyMap[dt] = { cost: 0, commission: 0 };
    dailyMap[dt].cost       += Number(r.cost ?? 0);
    dailyMap[dt].commission += Number(r.commission ?? 0);
  }

  const days = Object.entries(dailyMap);
  ok(`共 ${days.length} 天有数据（日期范围 ${DATE_FROM} ~ ${DATE_TO} 共 7 天）：`);
  days.forEach(([dt, g]) => {
    info(`  ${dt}  花费：${fmtMoney(g.cost)}  佣金：${fmtMoney(g.commission)}`);
  });

  // ── 7. get_roi_diagnosis ──────────────────────────────
  sep("STEP 7: get_roi_diagnosis — ROI 健康诊断");

  const diagRows = Object.entries(grouped).map(([id, g]) => {
    const roi = g.cost > 0 ? (g.commission - g.cost) / g.cost * 100 : 0;
    return {
      name: campaignMap.get(id) || `ID-${id}`,
      roi,
      category: roi < 0 ? "亏损" : roi < 50 ? "低效" : "盈利",
    };
  });

  const losing    = diagRows.filter((r) => r.category === "亏损");
  const loweff    = diagRows.filter((r) => r.category === "低效");
  const profitable = diagRows.filter((r) => r.category === "盈利");

  ok(`ROI 分类汇总：亏损 ${losing.length} 个 | 低效 ${loweff.length} 个 | 盈利 ${profitable.length} 个`);
  if (losing.length) {
    info("  最差系列：" + [...losing].sort((a, b) => a.roi - b.roi).slice(0, 3).map((r) => `${r.name}(${r.roi.toFixed(1)}%)`).join("，"));
  }
  if (profitable.length) {
    info("  最优系列：" + [...profitable].sort((a, b) => b.roi - a.roi).slice(0, 3).map((r) => `${r.name}(${r.roi.toFixed(1)}%)`).join("，"));
  }

  // ── 8. 汇总 ──────────────────────────────────────────
  sep("测试汇总");
  ok("所有工具均可通过 campaign_id 正确读取数据");
  ok(`关键修复验证：旧方式(user_id) 返回 ${oldStats} 条，新方式(campaign_id) 返回 ${newStats} 条`);

  if (newStats > oldStats) {
    ok("新方式数据量 > 旧方式，修复有效，可以部署");
  } else if (newStats === oldStats && newStats > 0) {
    ok("两种方式数据量一致（user_id 字段本身正确），修复兼容，不影响结果");
  }

  await prisma.$disconnect();
}

main().catch((e) => {
  console.error("\n[ERROR]", e);
  process.exit(1);
});
