/**
 * D-365 执行：把 campaign 29923（HYTEST US，01 报案那条）的后缀推到 Google Ads。
 *
 * 为什么只有 1 条：实证核对（d365-verify-google-side.ts / d365-verify-rival-two.ts）
 * 推翻了「从未换链 ⇒ Google 上是空的」这个推断 ——
 *   · 证据引擎 16 条 ENABLED：Google 侧后缀全在，且与库值逐字一致（它在提交前就把后缀写库了）
 *   · 竞品引擎 22 条已提交：19 条已被换链脚本覆盖、Google 侧有值；
 *     29894 / 29922 库里本来就是空的（真没有，不是丢了）
 *   · 全系统真敞口 = 29923 一条
 *
 * 安全口径：
 *   · 只动这一个 google_campaign_id，写死在常量里，不接受批量
 *   · 推送前再查一次 Google 侧，确认当前确实是空 —— 不空就中止（可能换链脚本刚换过，不能抢写）
 *   · 推送后回查一次，确认落地
 *   · 不改库（库里本来就是对的值），所以不需要数据回滚；真要撤就把 Google 侧那格清空
 *
 * 用法：cd /home/ubuntu/Google-Data-Analysis/crm-mvp && npx tsx scripts/d365-fix-29923.ts
 *       加 --dry-run 只看不写
 */
import { loadEnvFromProjectRoot } from "./load-env-from-dotenv-file";

const TARGET_CAMPAIGN_ID = 29923n;
const DRY_RUN = process.argv.includes("--dry-run");

async function main() {
  loadEnvFromProjectRoot();
  const { default: prisma } = await import("../src/lib/prisma");
  const { queryGoogleAds, mutateGoogleAds } = await import("../src/lib/google-ads/client");

  // 注：本脚本不 import lib/google-ads/mutate 里新增的 updateCampaignFinalUrlSuffix ——
  // 那个函数在我的分支上，生产机还没部署。为这一条去触发线上 next build 不值当
  // （低配机，按部署规则「非必要不反复构建」），所以就地写同一个 mutate 调用，
  // 与 mutate.ts 里的实现逐字同构（update_mask: final_url_suffix）。
  async function pushSuffix(
    creds: { mcc_id: string; developer_token: string; service_account_json: string },
    customerId: string,
    campaignId: string,
    newSuffix: string,
  ): Promise<{ success: boolean; message: string }> {
    try {
      const cid = customerId.replace(/-/g, "");
      const suffix = (newSuffix || "").trim().replace(/^[?&\s]+/, "").replace(/[?&\s]+$/, "").trim();
      await mutateGoogleAds(creds, customerId, [{
        campaign_operation: {
          update: {
            resource_name: `customers/${cid}/campaigns/${campaignId}`,
            final_url_suffix: suffix,
          },
          update_mask: "final_url_suffix",
        },
      }]);
      return { success: true, message: suffix ? `后缀已更新为 ${suffix}` : "后缀已清空" };
    } catch (err) {
      return { success: false, message: `后缀修改失败: ${err instanceof Error ? err.message : String(err)}` };
    }
  }

  const c = await prisma.campaigns.findFirst({
    where: { id: TARGET_CAMPAIGN_ID, is_deleted: 0 },
    select: {
      id: true, campaign_name: true, google_campaign_id: true, customer_id: true,
      mcc_id: true, google_status: true, final_url_suffix: true, suffix_last_apply_at: true,
    },
  });
  if (!c) throw new Error("系列不存在");
  if (!c.google_campaign_id || !c.customer_id || !c.mcc_id) throw new Error("缺 google_campaign_id / customer_id / mcc_id");

  const dbSuffix = (c.final_url_suffix || "").trim();
  if (!dbSuffix) throw new Error("库里没有后缀，无可推送");
  if (c.suffix_last_apply_at) throw new Error(`该系列已换过链（${c.suffix_last_apply_at}），Google 上生效的是换链值，本脚本不处理`);

  const mcc = await prisma.google_mcc_accounts.findFirst({
    where: { id: c.mcc_id, is_deleted: 0 },
    select: { mcc_id: true, developer_token: true, service_account_json: true },
  });
  if (!mcc) throw new Error("MCC 行不存在");
  const creds = {
    mcc_id: mcc.mcc_id,
    developer_token: mcc.developer_token || "",
    service_account_json: mcc.service_account_json || "",
  };

  console.log(`目标: campaign ${c.id}  ${c.campaign_name}`);
  console.log(`状态: ${c.google_status}   google_id=${c.google_campaign_id}  cid=${c.customer_id}`);
  console.log(`库值: ${dbSuffix}\n`);

  async function readGoogleSuffix(): Promise<string> {
    const res = await queryGoogleAds(
      creds, c!.customer_id!,
      `SELECT campaign.id, campaign.final_url_suffix FROM campaign WHERE campaign.id = ${c!.google_campaign_id}`,
    );
    if (res.length === 0) throw new Error("Google 上查不到该系列");
    const camp = res[0].campaign as Record<string, unknown>;
    return String(camp?.finalUrlSuffix ?? camp?.final_url_suffix ?? "").trim();
  }

  const before = await readGoogleSuffix();
  console.log(`推送前 Google 侧: ${before || "(空)"}`);
  if (before) {
    console.log("\n⚠️ Google 上已有后缀，中止 —— 不与换链脚本抢写。");
    await prisma.$disconnect();
    return;
  }

  if (DRY_RUN) {
    console.log("\n[dry-run] 将执行：把库值推到 Google。实际未写。");
    await prisma.$disconnect();
    return;
  }

  const r = await pushSuffix(creds, c.customer_id, c.google_campaign_id, dbSuffix);
  console.log(`\n推送结果: success=${r.success}  ${r.message}`);
  if (!r.success) {
    await prisma.$disconnect();
    process.exit(1);
  }

  const after = await readGoogleSuffix();
  console.log(`推送后 Google 侧: ${after || "(空)"}`);
  console.log(after === dbSuffix ? "\n✅ 已落地，与库值一致" : "\n⚠️ 落地值与库值不一致，请人工核对");

  await prisma.$disconnect();
}

main().catch((e) => { console.error(e); process.exit(1); });
