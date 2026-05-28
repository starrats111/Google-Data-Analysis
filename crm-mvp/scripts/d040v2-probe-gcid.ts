/**
 * D-040 v2 probe — 直接查 GAds 端 customer_id=6711109311 下所有 campaign（不带日期过滤）
 * 找出 gcid=23864905107 (CRM id=7861) 真实状态
 */
import { loadEnvFromProjectRoot } from "./load-env-from-dotenv-file";

async function main() {
  loadEnvFromProjectRoot();
  const { default: prisma } = await import("../src/lib/prisma");
  const { queryGoogleAds } = await import("../src/lib/google-ads/client");

  const mcc = await prisma.google_mcc_accounts.findFirst({ where: { id: 1n } });
  if (!mcc?.service_account_json || !mcc?.developer_token) {
    console.log("mcc 凭证缺失"); return;
  }
  const credentials = {
    mcc_id: mcc.mcc_id,
    developer_token: mcc.developer_token,
    service_account_json: mcc.service_account_json,
  };

  const cid = "6711109311";
  console.log(`\n=== A. customer_id=${cid} 所有 campaign 状态（不限日期）===`);
  try {
    const rows = (await queryGoogleAds(
      credentials, cid,
      `SELECT campaign.id, campaign.name, campaign.status FROM campaign`,
    )) as any[];
    const bruntRows = rows.filter((r) => String(r.campaign?.name || "").toUpperCase().includes("BRUNT"));
    console.log(`  总 campaign 数 = ${rows.length}; BRUNT 数 = ${bruntRows.length}`);
    for (const r of bruntRows) {
      console.log(`  gcid=${r.campaign?.id} status=${r.campaign?.status} name="${r.campaign?.name}"`);
    }
  } catch (e) {
    console.log(`  Error: ${e instanceof Error ? e.message : String(e)}`);
  }

  console.log(`\n=== B. customer_id=${cid} gcid=23864905107 详细每日 metrics ===`);
  try {
    const rows = (await queryGoogleAds(
      credentials, cid,
      `SELECT campaign.id, campaign.name, campaign.status, segments.date, metrics.cost_micros, metrics.clicks, metrics.impressions
       FROM campaign
       WHERE campaign.id = 23864905107
         AND segments.date BETWEEN '2026-05-15' AND '2026-05-28'`,
    )) as any[];
    console.log(`  返回行数 = ${rows.length}`);
    for (const r of rows) {
      const cost = Number(r.metrics?.costMicros || 0) / 1_000_000;
      console.log(
        `  date=${r.segments?.date} status=${r.campaign?.status} cost=$${cost.toFixed(2)}`
        + ` clicks=${r.metrics?.clicks} impr=${r.metrics?.impressions}`,
      );
    }
  } catch (e) {
    console.log(`  Error: ${e instanceof Error ? e.message : String(e)}`);
  }

  console.log(`\n=== C. customer_id=${cid} 所有当前 ENABLED+PAUSED 的 BRUNT campaign ===`);
  try {
    const rows = (await queryGoogleAds(
      credentials, cid,
      `SELECT campaign.id, campaign.name, campaign.status, segments.date, metrics.cost_micros
       FROM campaign
       WHERE campaign.name LIKE '%BRUNT%'
         AND segments.date BETWEEN '2026-05-01' AND '2026-05-28'`,
    )) as any[];
    const byG = new Map<string, { name: string; status: string; cost: number; days: number }>();
    for (const r of rows) {
      const gid = String(r.campaign?.id || "");
      const cost = Number(r.metrics?.costMicros || 0) / 1_000_000;
      const e = byG.get(gid);
      if (!e) byG.set(gid, { name: String(r.campaign?.name), status: String(r.campaign?.status), cost, days: 1 });
      else { e.cost += cost; e.days++; }
    }
    for (const [gid, v] of byG) {
      console.log(`  gcid=${gid} status=${v.status} 2026-05 cost=$${v.cost.toFixed(2)} days=${v.days} name="${v.name}"`);
    }
  } catch (e) {
    console.log(`  Error: ${e instanceof Error ? e.message : String(e)}`);
  }

  await prisma.$disconnect();
}

main().catch((e) => { console.error(e); process.exit(1); });
