/**
 * D-365 核对2：竞品引擎那 2 条（26355 / 29923，含 01 报案的 HYTEST US）
 * 以及全部竞品引擎已提交系列的 Google 侧后缀真值。
 *
 * 上一轮核对推翻了「从未换链 ⇒ Google 上是空的」这个推断：证据引擎的 16 条在 Google 上
 * 后缀全在。所以必须单独验竞品引擎这条路 —— 它才是「提交时库里确实是 NULL」的那一批。
 *
 * 只读（GAQL SELECT）。
 * 用法：cd /home/ubuntu/Google-Data-Analysis/crm-mvp && npx tsx scripts/d365-verify-rival-two.ts
 */
import { loadEnvFromProjectRoot } from "./load-env-from-dotenv-file";

async function main() {
  loadEnvFromProjectRoot();
  const { default: prisma } = await import("../src/lib/prisma");
  const { queryGoogleAds } = await import("../src/lib/google-ads/client");

  // 竞品引擎 = 有 ad_creation_drafts 行关联的系列
  const drafts = await prisma.ad_creation_drafts.findMany({
    where: { is_deleted: 0, campaign_id: { not: null } },
    select: { id: true, status: true, campaign_id: true, user_id: true },
    orderBy: { id: "desc" },
  });
  const campIds = drafts.map((d) => d.campaign_id!).filter(Boolean);

  const rows = await prisma.campaigns.findMany({
    where: { id: { in: campIds }, is_deleted: 0, google_campaign_id: { not: null } },
    select: {
      id: true, campaign_name: true, google_campaign_id: true, customer_id: true,
      mcc_id: true, google_status: true, final_url_suffix: true,
      suffix_last_apply_at: true, suffix_last_content: true, created_at: true,
    },
    orderBy: { id: "asc" },
  });

  console.log(`竞品引擎已提交系列 ${rows.length} 条\n`);

  const mccCache = new Map<string, { mcc_id: string; developer_token: string; service_account_json: string } | null>();
  async function creds(pk: bigint) {
    const k = String(pk);
    if (!mccCache.has(k)) {
      const m = await prisma.google_mcc_accounts.findFirst({
        where: { id: pk, is_deleted: 0 },
        select: { mcc_id: true, developer_token: true, service_account_json: true },
      });
      mccCache.set(k, m ? {
        mcc_id: m.mcc_id,
        developer_token: m.developer_token || "",
        service_account_json: m.service_account_json || "",
      } : null);
    }
    return mccCache.get(k)!;
  }

  let googleEmpty = 0, googleSet = 0, failed = 0;

  for (const r of rows) {
    const dbSuffix = (r.final_url_suffix || "").trim();
    const applied = (r.suffix_last_content || "").trim();
    let gSuffix = "(查询失败)";
    if (r.mcc_id && r.customer_id && r.google_campaign_id) {
      const c = await creds(r.mcc_id);
      if (c) {
        try {
          const res = await queryGoogleAds(
            c, r.customer_id,
            `SELECT campaign.id, campaign.final_url_suffix FROM campaign WHERE campaign.id = ${r.google_campaign_id}`,
          );
          if (res.length === 0) { gSuffix = "(Google 上无此系列)"; failed++; }
          else {
            const camp = res[0].campaign as Record<string, unknown>;
            gSuffix = String(camp?.finalUrlSuffix ?? camp?.final_url_suffix ?? "").trim();
            if (gSuffix) googleSet++; else { gSuffix = "(空)"; googleEmpty++; }
          }
        } catch (e) { gSuffix = `(错误: ${e instanceof Error ? e.message.slice(0, 60) : e})`; failed++; }
      } else { gSuffix = "(MCC 行缺失)"; failed++; }
    } else { gSuffix = "(缺 mcc/cid)"; failed++; }

    console.log(`campaign ${r.id}  ${r.google_status}  ${r.campaign_name}`);
    console.log(`  建于      : ${r.created_at?.toISOString?.() ?? r.created_at}`);
    console.log(`  库 suffix : ${dbSuffix || "(空)"}`);
    console.log(`  换链时间  : ${r.suffix_last_apply_at ? String(r.suffix_last_apply_at) : "(从未换链)"}`);
    console.log(`  换链内容  : ${applied || "(无)"}`);
    console.log(`  Google    : ${gSuffix}`);
    console.log(`  >>> ${gSuffix === "(空)" && dbSuffix ? "★ 敞口：库里有、Google 没有" : "—"}\n`);
  }

  console.log("═".repeat(60));
  console.log(`Google 有后缀 ${googleSet} / Google 空 ${googleEmpty} / 失败 ${failed}`);
  await prisma.$disconnect();
}

main().catch((e) => { console.error(e); process.exit(1); });
