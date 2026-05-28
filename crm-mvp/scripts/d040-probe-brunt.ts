/**
 * D-040 v2 probe — 探查 wj07 BRUNT 重发广告匹配为什么失败
 *
 * 目标：
 *   1. 从 CRM 取 wj07 (user_id=8) 所有 campaign_name LIKE '%BRUNT%' 的 campaigns
 *      (id, name, customer_id, google_campaign_id, previous_gcids, status, mcc_id)
 *   2. 找出这些 campaign 关联的 mcc 凭证
 *   3. 直接 GAQL 查询 GAds 里 customer_id 下所有 REMOVED + ENABLED + PAUSED 状态的
 *      campaign（带 segments.date BETWEEN），看 campaign.name 长啥样
 *   4. 对比 CRM.campaign_name vs GAds.campaign.name，找出差异原因
 */

import { loadEnvFromProjectRoot } from "./load-env-from-dotenv-file";

async function main() {
  loadEnvFromProjectRoot();
  const { default: prisma } = await import("../src/lib/prisma");
  const { queryGoogleAds } = await import("../src/lib/google-ads/client");

  const USER_ID = BigInt(process.env.USER_ID || 8);
  console.log("Probing user_id =", USER_ID);

  // 1) CRM 端取所有 BRUNT
  const bruntCampaigns = await prisma.campaigns.findMany({
    where: {
      user_id: USER_ID,
      is_deleted: 0,
      campaign_name: { contains: "BRUNT" },
    },
    select: {
      id: true,
      campaign_name: true,
      customer_id: true,
      google_campaign_id: true,
      previous_gcids: true,
      status: true,
      google_status: true,
      mcc_id: true,
      created_at: true,
    },
    orderBy: { id: "asc" },
  });

  console.log("\n=== CRM campaigns LIKE %BRUNT% ===");
  for (const c of bruntCampaigns) {
    console.log(
      `  id=${c.id} mcc=${c.mcc_id} cid=${c.customer_id} gcid=${c.google_campaign_id} status=${c.status}/${c.google_status}`
      + ` name="${c.campaign_name}" prev=${JSON.stringify(c.previous_gcids)}`,
    );
  }

  if (bruntCampaigns.length === 0) {
    console.log("没有找到 BRUNT campaign，退出");
    await prisma.$disconnect();
    return;
  }

  // 2) 对每个独立 (mcc_id, customer_id) 跑一次 GAds 查询
  const seen = new Set<string>();
  for (const c of bruntCampaigns) {
    if (!c.mcc_id || !c.customer_id) continue;
    const key = `${c.mcc_id}|${c.customer_id}`;
    if (seen.has(key)) continue;
    seen.add(key);

    const mcc = await prisma.google_mcc_accounts.findUnique({ where: { id: c.mcc_id } });
    if (!mcc || !mcc.developer_token || !mcc.service_account_json) {
      console.log(`  mcc=${c.mcc_id} 凭证缺失，跳过`);
      continue;
    }
    const credentials = {
      mcc_id: mcc.mcc_id,
      developer_token: mcc.developer_token,
      service_account_json: mcc.service_account_json,
    };

    console.log(`\n=== GAds query mcc=${mcc.mcc_id} customer_id=${c.customer_id} ===`);
    try {
      const rows = (await queryGoogleAds(
        credentials,
        c.customer_id,
        `
        SELECT
          campaign.id, campaign.name, campaign.status,
          customer.id,
          segments.date,
          metrics.cost_micros
        FROM campaign
        WHERE segments.date BETWEEN '2026-01-01' AND '${new Date().toISOString().slice(0, 10)}'
      `,
      )) as any[];

      // group by gcid
      const byGcid = new Map<
        string,
        { name: string; status: string; cidRaw: string; totalCost: number; days: number }
      >();
      for (const r of rows) {
        const gid = String(r.campaign?.id ?? "");
        if (!gid) continue;
        const name = String(r.campaign?.name ?? "");
        const status = String(r.campaign?.status ?? "");
        const cidRaw = String(r.customer?.id ?? "");
        const cost = Number(r.metrics?.costMicros ?? 0) / 1_000_000;
        if (!byGcid.has(gid)) byGcid.set(gid, { name, status, cidRaw, totalCost: 0, days: 0 });
        const e = byGcid.get(gid)!;
        e.totalCost += cost;
        e.days++;
      }

      const bruntGAds = [...byGcid.entries()].filter(([, v]) => v.name.toUpperCase().includes("BRUNT"));
      console.log(`  GAds 中 BRUNT 相关 gcid 数: ${bruntGAds.length}`);
      for (const [gid, v] of bruntGAds) {
        console.log(
          `    gcid=${gid} status=${v.status} cost=$${v.totalCost.toFixed(2)} days=${v.days}`
          + ` cidRaw=${v.cidRaw} name="${v.name}"`,
        );
      }

      // 列出该 cid 下所有 REMOVED 状态的 gcid（不限名字），看看其它 REMOVED 长啥样
      const allRemoved = [...byGcid.entries()].filter(([, v]) => v.status === "REMOVED");
      console.log(`  GAds 中所有 REMOVED gcid 数: ${allRemoved.length}（取前 5 个示范）`);
      for (const [gid, v] of allRemoved.slice(0, 5)) {
        console.log(`    REMOVED gcid=${gid} cost=$${v.totalCost.toFixed(2)} name="${v.name}"`);
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      console.log(`  Error: ${msg.slice(0, 200)}`);
    }
  }

  await prisma.$disconnect();
}

main().catch((e) => {
  console.error("Fatal:", e);
  process.exit(1);
});
