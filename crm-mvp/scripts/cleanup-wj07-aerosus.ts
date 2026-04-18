/**
 * C-016 一次性清洗脚本：清理 wj07 Aerosus BE 广告的脏数据
 *
 * 触发原因：
 *   C-014 / C-015 期间，为 user wj07 的 Aerosus BE 广告生成流程污染了以下字段：
 *     - ad_creatives.final_url:       错误地指向 aerosus.nl（应是 aerosus.be）
 *     - ad_creatives.headlines:       出现 "Aerosus NL - 2 Jaar Garantie"
 *     - ad_creatives.descriptions:    可能含 NL 标签
 *     - ad_creatives.sitelinks:       基于 aerosus.nl 的 URL
 *     - ad_creatives.callouts:        同上
 *     - ad_creatives.crawl_cache:     基于 aerosus.nl 爬取的旧缓存
 *
 * 清洗策略（仅限 acid=390）：
 *   - 所有 AI 生成字段 → null
 *   - crawl_cache → null（下次生成时由 C-016 resolveCountryUrl 重新解析为 aerosus.be）
 *   - 不动 user_merchants（07 明确指示："其他的等他们做到这个广告了以后再手动切换"）
 *
 * 使用方式：
 *   npx tsx scripts/cleanup-wj07-aerosus.ts          # dry-run
 *   npx tsx scripts/cleanup-wj07-aerosus.ts --apply  # 真正执行
 */
import * as fs from "fs";
import * as path from "path";
const envPath = path.join(process.cwd(), ".env");
if (fs.existsSync(envPath)) {
  for (const line of fs.readFileSync(envPath, "utf8").split("\n")) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)$/);
    if (m && !process.env[m[1]]) {
      process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
    }
  }
}
import prisma from "../src/lib/prisma";

const APPLY = process.argv.slice(2).includes("--apply");
const TARGET_AD_CREATIVE_ID = BigInt(390);

async function main() {
  console.log(`=== C-016 wj07 Aerosus 清洗 ===`);
  console.log(`模式: ${APPLY ? "APPLY（真正执行）" : "DRY-RUN（仅输出计划）"}`);
  console.log(`目标 ad_creatives.id = ${TARGET_AD_CREATIVE_ID}\n`);

  const ac = await prisma.ad_creatives.findFirst({
    where: { id: TARGET_AD_CREATIVE_ID, is_deleted: 0 },
    select: {
      id: true,
      ad_group_id: true,
      final_url: true,
      headlines: true,
      descriptions: true,
      sitelinks: true,
      callouts: true,
      display_path1: true,
      display_path2: true,
      crawl_cache: true,
    },
  });

  if (!ac) {
    console.error(`❌ 未找到 ad_creatives.id=${TARGET_AD_CREATIVE_ID}，终止`);
    process.exit(1);
  }

  const adGroup = await prisma.ad_groups.findFirst({
    where: { id: ac.ad_group_id, is_deleted: 0 },
    select: { id: true, campaign_id: true },
  });
  if (!adGroup) {
    console.error(`❌ 未找到 ad_group.id=${ac.ad_group_id}，终止`);
    process.exit(1);
  }
  const campaign = await prisma.campaigns.findFirst({
    where: { id: adGroup.campaign_id, is_deleted: 0 },
    select: { id: true, user_id: true, user_merchant_id: true, target_country: true, name: true },
  });
  if (!campaign) {
    console.error(`❌ 未找到 campaign.id=${adGroup.campaign_id}，终止`);
    process.exit(1);
  }
  const merchant = await prisma.user_merchants.findFirst({
    where: { id: campaign.user_merchant_id, is_deleted: 0 },
    select: { id: true, merchant_name: true, merchant_url: true },
  });

  console.log(`[Target] campaign=${campaign.name} user_id=${campaign.user_id} target_country=${campaign.target_country}`);
  console.log(`[Target] merchant=${merchant?.merchant_name} (${merchant?.merchant_url})`);
  console.log(`[Before] final_url=${ac.final_url}`);
  console.log(`[Before] headlines=${Array.isArray(ac.headlines) ? (ac.headlines as unknown[]).length : 0} 条`);
  console.log(`[Before] descriptions=${Array.isArray(ac.descriptions) ? (ac.descriptions as unknown[]).length : 0} 条`);
  console.log(`[Before] sitelinks=${Array.isArray(ac.sitelinks) ? (ac.sitelinks as unknown[]).length : 0} 条`);
  console.log(`[Before] callouts=${Array.isArray(ac.callouts) ? (ac.callouts as unknown[]).length : 0} 条`);
  console.log(`[Before] crawl_cache=${ac.crawl_cache ? "存在" : "空"}`);

  if (!APPLY) {
    console.log(`\n[Plan]`);
    console.log(`  - final_url: ${ac.final_url} → null（下次生成由 resolveCountryUrl(BE) 解析为 aerosus.be）`);
    console.log(`  - headlines / descriptions / sitelinks / callouts → null（AI 重新生成）`);
    console.log(`  - display_path1 / display_path2 → null`);
    console.log(`  - crawl_cache → null（触发重爬）`);
    console.log(`  - 不动 user_merchants（07 明确要求）`);
    console.log(`\n[DRY-RUN] 未写入。再次用 --apply 真正执行。`);
    return;
  }

  const updated = await prisma.ad_creatives.update({
    where: { id: TARGET_AD_CREATIVE_ID },
    data: {
      final_url: null,
      headlines: null as any,
      descriptions: null as any,
      sitelinks: null as any,
      callouts: null as any,
      display_path1: null,
      display_path2: null,
      crawl_cache: null as any,
    },
    select: { id: true },
  });

  console.log(`\n[APPLY] ad_creatives.id=${updated.id} 字段已清空`);
  console.log(`下一步：用户在 /user/ad-preview/${campaign.id} 重新打开该广告，generate-extensions 将自动：`);
  console.log(`  1. resolveCountryUrl(${merchant?.merchant_url || "原 URL"}, ${campaign.target_country}) → DNS+TCP 探测 → aerosus.be`);
  console.log(`  2. 写回 ad_creatives.final_url = aerosus.be`);
  console.log(`  3. extractBrandRoot("${merchant?.merchant_name}") → 去 NL 后缀喂给 AI prompt`);
  console.log(`  4. 重新爬取 aerosus.be 全链路（生成合规 crawl_cache）`);
  console.log(`  5. AI 用荷语（BE 国家默认）生成全新 headlines/descriptions/sitelinks/callouts`);
  console.log(`  6. 走 C-016 Google 政策闸 + claim 验证软闸`);
}

main()
  .catch((err) => {
    console.error("❌ 清洗脚本异常:", err);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
