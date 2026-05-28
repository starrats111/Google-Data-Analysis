/**
 * D-040 v2 probe — 显式查 cid=6711109311 下所有 status（含 REMOVED）的 BRUNT campaign
 * 验证 GAds 后台截图里"两行 BRUNT" = 两个不同 gcid 的真相
 */
import { loadEnvFromProjectRoot } from "./load-env-from-dotenv-file";

async function main() {
  loadEnvFromProjectRoot();
  const { default: prisma } = await import("../src/lib/prisma");
  const { queryGoogleAds } = await import("../src/lib/google-ads/client");

  const mcc = await prisma.google_mcc_accounts.findFirst({ where: { id: 1n } });
  if (!mcc?.service_account_json || !mcc?.developer_token) { console.log("mcc 凭证缺失"); return; }
  const credentials = {
    mcc_id: mcc.mcc_id,
    developer_token: mcc.developer_token,
    service_account_json: mcc.service_account_json,
  };
  const cid = "6711109311";

  console.log("\n=== A. 显式查 ALL status BRUNT campaign（不过滤 REMOVED）===");
  try {
    const rows = (await queryGoogleAds(credentials, cid, `
      SELECT campaign.id, campaign.name, campaign.status, campaign.start_date, campaign.end_date
      FROM campaign
      WHERE campaign.name LIKE '%BRUNT%'
        AND campaign.status IN ('ENABLED','PAUSED','REMOVED')
    `)) as any[];
    console.log(`  返回行数 = ${rows.length}`);
    for (const r of rows) {
      console.log(`  gcid=${r.campaign?.id} status=${r.campaign?.status} start=${r.campaign?.startDate} end=${r.campaign?.endDate} name="${r.campaign?.name}"`);
    }
  } catch (e) { console.log(`Error: ${e instanceof Error ? e.message : String(e)}`); }

  console.log("\n=== B. 每条 BRUNT campaign 2026-04~2026-05 daily cost ===");
  try {
    const rows = (await queryGoogleAds(credentials, cid, `
      SELECT campaign.id, campaign.name, campaign.status, segments.date,
             metrics.cost_micros, metrics.clicks, metrics.impressions
      FROM campaign
      WHERE campaign.name LIKE '%BRUNT%'
        AND campaign.status IN ('ENABLED','PAUSED','REMOVED')
        AND segments.date BETWEEN '2026-04-01' AND '2026-05-28'
    `)) as any[];
    const byG = new Map<string, { name: string; status: string; cost: number; clicks: number; impr: number; days: number; firstDate: string; lastDate: string }>();
    for (const r of rows) {
      const gid = String(r.campaign?.id || "");
      const cost = Number(r.metrics?.costMicros || 0) / 1_000_000;
      const clicks = Number(r.metrics?.clicks || 0);
      const impr = Number(r.metrics?.impressions || 0);
      const date = String(r.segments?.date || "");
      const status = String(r.campaign?.status || "");
      const name = String(r.campaign?.name || "");
      const e = byG.get(gid);
      if (!e) byG.set(gid, { name, status, cost, clicks, impr, days: 1, firstDate: date, lastDate: date });
      else {
        e.cost += cost; e.clicks += clicks; e.impr += impr; e.days++;
        if (date < e.firstDate) e.firstDate = date;
        if (date > e.lastDate) e.lastDate = date;
      }
    }
    for (const [gid, v] of byG) {
      console.log(`  gcid=${gid} status=${v.status} cost=$${v.cost.toFixed(2)} clicks=${v.clicks} impr=${v.impr} days=${v.days} ${v.firstDate}~${v.lastDate} name="${v.name}"`);
    }
  } catch (e) { console.log(`Error: ${e instanceof Error ? e.message : String(e)}`); }

  console.log("\n=== C. CRM 里这些 gcid 的归属（看哪些已经在 campaigns 表，哪些丢失）===");
  // 拿到 A 步的 gcid 列表
  try {
    const rows = (await queryGoogleAds(credentials, cid, `
      SELECT campaign.id, campaign.name, campaign.status
      FROM campaign
      WHERE campaign.name LIKE '%BRUNT%'
        AND campaign.status IN ('ENABLED','PAUSED','REMOVED')
    `)) as any[];
    const gcids = rows.map((r) => String(r.campaign?.id || "")).filter(Boolean);
    if (gcids.length === 0) { console.log("无 gcid"); return; }

    const existing = await prisma.campaigns.findMany({
      where: { google_campaign_id: { in: gcids }, is_deleted: 0 },
      select: { id: true, user_id: true, google_campaign_id: true, campaign_name: true, customer_id: true, status: true, google_status: true, previous_gcids: true },
    });
    console.log(`  CRM 中存在 ${existing.length} 条 (输入 ${gcids.length})`);
    for (const c of existing) {
      console.log(`  CRM campaign id=${c.id} user_id=${c.user_id} gcid=${c.google_campaign_id} status=${c.status}/${c.google_status} prev=${JSON.stringify(c.previous_gcids)} name="${c.campaign_name}"`);
    }
    const existingGcids = new Set(existing.map((c) => c.google_campaign_id));
    const orphans = gcids.filter((g) => !existingGcids.has(g));
    console.log(`  GAds 上存在但 CRM 没记录的 gcid: ${JSON.stringify(orphans)}`);

    // 检查这些 orphan gcid 是否在某条 campaign 的 previous_gcids 里
    if (orphans.length > 0) {
      const allPrev = await prisma.campaigns.findMany({
        where: { user_id: 8n, is_deleted: 0 },
        select: { id: true, google_campaign_id: true, campaign_name: true, previous_gcids: true },
      });
      for (const o of orphans) {
        const hit = allPrev.find((c) => Array.isArray(c.previous_gcids) && (c.previous_gcids as any[]).map(String).includes(o));
        if (hit) console.log(`    orphan gcid=${o} 在 campaign id=${hit.id} (${hit.campaign_name}) 的 previous_gcids 里`);
        else console.log(`    orphan gcid=${o} 完全无主`);
      }
    }
  } catch (e) { console.log(`Error: ${e instanceof Error ? e.message : String(e)}`); }

  await prisma.$disconnect();
}

main().catch((e) => { console.error(e); process.exit(1); });
