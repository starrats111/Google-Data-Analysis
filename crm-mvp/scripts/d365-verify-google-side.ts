/**
 * D-365 核对：去 Google Ads 问这批系列「你那边的 final_url_suffix 到底是什么」
 *
 * 只读（GAQL SELECT），不写任何东西。目的是在批量补推之前拿到真值 ——
 * 库里 final_url_suffix 非空 + suffix_last_apply_at 为空，只是「推断」Google 上是空的，
 * 必须实证。顺带把实际不空的排除掉，避免白推一遍去和换链抢写。
 *
 * 用法（在 CRM 机上）：
 *   cd /home/ubuntu/crm-mvp && npx tsx scripts/d365-verify-google-side.ts
 */
import { loadEnvFromProjectRoot } from "./load-env-from-dotenv-file";

async function main() {
  // 必须先于 prisma / google-ads 的 import —— 这两个模块在加载时就读 env
  loadEnvFromProjectRoot();
  const { default: prisma } = await import("../src/lib/prisma");
  const { queryGoogleAds } = await import("../src/lib/google-ads/client");

  // 与探查 SQL 完全同一口径：已提交 + 在投 + 从未换链 + 库里有后缀
  const rows = await prisma.campaigns.findMany({
    where: {
      is_deleted: 0,
      google_status: "ENABLED",
      suffix_last_apply_at: null,
      google_campaign_id: { not: null },
      NOT: [{ final_url_suffix: null }, { final_url_suffix: "" }],
    },
    select: {
      id: true,
      user_id: true,
      campaign_name: true,
      google_campaign_id: true,
      customer_id: true,
      mcc_id: true,
      final_url_suffix: true,
    },
    orderBy: { id: "asc" },
  });

  console.log(`待核对 ${rows.length} 条\n`);

  const mccCache = new Map<string, { mcc_id: string; developer_token: string; service_account_json: string } | null>();
  async function creds(mccPk: bigint) {
    const key = String(mccPk);
    if (!mccCache.has(key)) {
      const m = await prisma.google_mcc_accounts.findFirst({
        where: { id: mccPk, is_deleted: 0 },
        select: { mcc_id: true, developer_token: true, service_account_json: true },
      });
      mccCache.set(
        key,
        m ? { mcc_id: m.mcc_id, developer_token: m.developer_token || "", service_account_json: m.service_account_json || "" } : null,
      );
    }
    return mccCache.get(key)!;
  }

  const empty: typeof rows = [];
  const nonEmpty: Array<{ row: (typeof rows)[number]; googleSuffix: string }> = [];
  const failed: Array<{ row: (typeof rows)[number]; err: string }> = [];

  for (const r of rows) {
    if (!r.mcc_id || !r.customer_id || !r.google_campaign_id) {
      failed.push({ row: r, err: "缺 mcc_id / customer_id / google_campaign_id" });
      continue;
    }
    const c = await creds(r.mcc_id);
    if (!c) {
      failed.push({ row: r, err: "MCC 行不存在" });
      continue;
    }
    try {
      const res = await queryGoogleAds(
        c,
        r.customer_id,
        `SELECT campaign.id, campaign.final_url_suffix, campaign.status
         FROM campaign WHERE campaign.id = ${r.google_campaign_id}`,
      );
      if (res.length === 0) {
        failed.push({ row: r, err: "Google 上查不到该系列" });
        continue;
      }
      const camp = res[0].campaign as Record<string, unknown>;
      const gSuffix = String(camp?.finalUrlSuffix ?? camp?.final_url_suffix ?? "").trim();
      if (!gSuffix) empty.push(r);
      else nonEmpty.push({ row: r, googleSuffix: gSuffix });
    } catch (e) {
      failed.push({ row: r, err: e instanceof Error ? e.message : String(e) });
    }
  }

  console.log("═══ A. Google 上确实为空（可补） ═══");
  for (const r of empty) {
    console.log(`  ${r.id}\t${r.campaign_name}\tcid=${r.customer_id}\n\t库值: ${r.final_url_suffix}`);
  }
  console.log(`  小计 ${empty.length} 条\n`);

  console.log("═══ B. Google 上并不空（不要动，推断有误） ═══");
  for (const { row, googleSuffix } of nonEmpty) {
    const same = googleSuffix === (row.final_url_suffix || "").trim();
    console.log(`  ${row.id}\t${row.campaign_name}\t${same ? "与库值一致" : "与库值不同"}`);
    if (!same) {
      console.log(`\tGoogle: ${googleSuffix}`);
      console.log(`\t库值  : ${row.final_url_suffix}`);
    }
  }
  console.log(`  小计 ${nonEmpty.length} 条\n`);

  console.log("═══ C. 查不到 / 失败 ═══");
  for (const { row, err } of failed) console.log(`  ${row.id}\t${row.campaign_name}\t${err}`);
  console.log(`  小计 ${failed.length} 条\n`);

  console.log(`合计 ${rows.length} = 可补 ${empty.length} + 非空 ${nonEmpty.length} + 失败 ${failed.length}`);
  await prisma.$disconnect();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
