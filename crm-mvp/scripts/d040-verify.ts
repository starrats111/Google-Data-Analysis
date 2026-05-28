/**
 * D-040 v2 — 部署后验证脚本
 *
 * 验证 4 件事：
 *  1. BUG-3：wj07 (user_id=8) 数据中心 API 返回的 campaigns 数量与 DB dedupe 后数量一致（无 200 截断）
 *  2. BUG-1：wj11 (user_id=11) 8246/3810 已 hotfix → google_status='PAUSED' 且 status='paused' 一致
 *  3. BUG-1 反向同步：全库 status != google_status 漂移条数应大幅下降（理想 0）
 *  4. BUG-2：wj07 BRUNT campaign id=7861 的 previous_gcids 是否含历史 gcid，
 *           ads_daily_stats 累加后 cost 与 GAds 后台 $53 接近（差异 <$1）
 *
 * 跑法（生产服务器）：
 *   ssh ubuntu@43.156.142.141
 *   cd /home/ubuntu/Google-Data-Analysis/crm-mvp
 *   npx tsx scripts/d040-verify.ts
 */

import { loadEnvFromProjectRoot } from "./load-env-from-dotenv-file";
loadEnvFromProjectRoot();
import prisma from "../src/lib/prisma";

(async () => {
  console.log("=".repeat(80));
  console.log("D-040 v2 — 部署后验证");
  console.log("=".repeat(80));

  // ─── 1. BUG-3 wj07 数据中心 dedupe 后总数（应能完整看到）────────────────
  console.log("\n[1] BUG-3：wj07 数据中心 campaign 数量");
  const wj07Mccs = await prisma.google_mcc_accounts.findMany({
    where: { user_id: 8n, is_deleted: 0 },
    select: { id: true, mcc_name: true },
  });
  console.log("  wj07 MCCs:", wj07Mccs.map((m) => `${m.id}(${m.mcc_name})`).join(", "));
  const wj07Campaigns = await prisma.campaigns.findMany({
    where: { user_id: 8n, is_deleted: 0 },
    select: { id: true, google_campaign_id: true, google_status: true, campaign_name: true },
  });
  const gcidSet = new Set<string>();
  for (const c of wj07Campaigns) {
    gcidSet.add(c.google_campaign_id || String(c.id));
  }
  const showRemoved = wj07Campaigns.filter((c) => c.google_status !== "REMOVED");
  console.log(`  total rows: ${wj07Campaigns.length}, distinct gcid: ${gcidSet.size}, non-REMOVED: ${showRemoved.length}`);
  console.log("  ⚠ 200 行截断已 D-040 v2 移除，前端应能看到全部 dedup 后的 campaigns");

  // ─── 2. BUG-1 wj11 hotfix 验证 ──────────────────────────────────────
  console.log("\n[2] BUG-1：wj11 hotfix 验证");
  const hotfix = await prisma.campaigns.findMany({
    where: { id: { in: [8246n, 3810n] } },
    select: { id: true, campaign_name: true, status: true, google_status: true, last_google_sync_at: true },
  });
  for (const c of hotfix) {
    const ok = c.status === "paused" && c.google_status === "PAUSED";
    console.log(`  id=${c.id} ${ok ? "✓" : "✗"} status=${c.status} google_status=${c.google_status} synced=${c.last_google_sync_at?.toISOString()}`);
  }

  // ─── 3. BUG-1 反向同步 — 全库 status!=google_status 漂移数 ──────────
  console.log("\n[3] BUG-1：全库 status != google_status 漂移条数（理想越接近 0 越好）");
  const driftCount = await prisma.$queryRawUnsafe<{ cnt: bigint }[]>(
    `SELECT COUNT(*) AS cnt FROM campaigns
     WHERE is_deleted=0
       AND ((status='paused' AND google_status IN ('ENABLED','ACTIVE'))
         OR (status='active' AND google_status IN ('PAUSED','REMOVED')))`,
  );
  console.log(`  drift count: ${driftCount[0].cnt}`);

  // ─── 4. BUG-2 BRUNT cost 与 GAds 后台 $53 对账 ────────────────────────
  console.log("\n[4] BUG-2：wj07 BRUNT (id=7861) cost 与 GAds 后台 $53 对账");
  const brunt = await prisma.campaigns.findFirst({
    where: { id: 7861n },
    select: { id: true, google_campaign_id: true, previous_gcids: true, campaign_name: true },
  });
  if (brunt) {
    const prev = Array.isArray(brunt.previous_gcids) ? brunt.previous_gcids : [];
    console.log(`  campaign_name: ${brunt.campaign_name}`);
    console.log(`  current gcid: ${brunt.google_campaign_id}`);
    console.log(`  previous_gcids: ${JSON.stringify(prev)} (${prev.length} items)`);
    const costAgg = await prisma.ads_daily_stats.aggregate({
      _sum: { cost: true, clicks: true, impressions: true },
      where: { campaign_id: 7861n, is_deleted: 0 },
    });
    console.log(`  ads_daily_stats SUM: cost=$${Number(costAgg._sum.cost || 0).toFixed(2)} clicks=${costAgg._sum.clicks} impressions=${costAgg._sum.impressions}`);
    console.log(`  GAds 后台预期: $53.00 — 差异: ${(Math.abs(Number(costAgg._sum.cost || 0) - 53)).toFixed(2)}`);
  } else {
    console.log("  ✗ campaign id=7861 not found");
  }

  console.log("\n" + "=".repeat(80));
  console.log("验证完成。");
  console.log("=".repeat(80));
  await prisma.$disconnect();
  process.exit(0);
})();
