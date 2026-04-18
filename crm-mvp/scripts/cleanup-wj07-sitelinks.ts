/**
 * C-016 针对性清洗脚本：仅清 wj07 Aerosus BE 广告的 sitelinks
 *
 * 触发原因：
 *   首次生成时 sitelink-auto-expand 未过滤 sitemap.xml 的嵌套索引，
 *   导致 ad_creatives.id=390 的 sitelinks 被写入 4 条 XML 文件链接。
 *   headlines / descriptions / image_urls 已正常（荷兰语、无 NL 后缀），无需清洗。
 *
 * 清洗策略（仅限 acid=390）：
 *   - sitelinks → []（空数组，让 generate-extensions 重跑 sitelink 扩源）
 *   - 不动 headlines / descriptions / image_urls / crawl_cache / final_url
 *
 * 使用：
 *   npx tsx scripts/cleanup-wj07-sitelinks.ts          # dry-run
 *   npx tsx scripts/cleanup-wj07-sitelinks.ts --apply  # 真正执行
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

const APPLY = process.argv.slice(2).includes("--apply");
const TARGET_AD_CREATIVE_ID = BigInt(390);

async function main() {
  const { default: prisma } = await import("../src/lib/prisma");
  console.log(`=== C-016 wj07 Aerosus sitelinks 清洗 ===`);
  console.log(`模式: ${APPLY ? "APPLY" : "DRY-RUN"}`);
  console.log(`目标 ad_creatives.id = ${TARGET_AD_CREATIVE_ID}\n`);

  const ac = await prisma.ad_creatives.findFirst({
    where: { id: TARGET_AD_CREATIVE_ID, is_deleted: 0 },
    select: { id: true, sitelinks: true, headlines: true, descriptions: true, image_urls: true },
  });
  if (!ac) {
    console.error("❌ 未找到");
    process.exit(1);
  }

  console.log(`[Before] sitelinks=${Array.isArray(ac.sitelinks) ? (ac.sitelinks as unknown[]).length : 0} 条`);
  console.log(`[Before] headlines=${Array.isArray(ac.headlines) ? (ac.headlines as unknown[]).length : 0} 条（保留）`);
  console.log(`[Before] descriptions=${Array.isArray(ac.descriptions) ? (ac.descriptions as unknown[]).length : 0} 条（保留）`);
  console.log(`[Before] image_urls=${Array.isArray(ac.image_urls) ? (ac.image_urls as unknown[]).length : 0} 张（保留）`);
  console.log(`\n[sitelinks 样本]:`);
  if (Array.isArray(ac.sitelinks)) {
    for (const sl of (ac.sitelinks as Array<Record<string, string>>).slice(0, 5)) {
      console.log(`  - ${sl.url}`);
    }
  }

  if (!APPLY) {
    console.log(`\n[DRY-RUN] 将清空 sitelinks 为 []。用 --apply 真正执行。`);
    await prisma.$disconnect();
    return;
  }

  await prisma.ad_creatives.update({
    where: { id: TARGET_AD_CREATIVE_ID },
    data: { sitelinks: [] as any },
  });
  console.log(`\n[APPLY] sitelinks 已清空`);
  console.log(`下一步：用户在前端重新点"生成"，或直接调 generate-extensions，将走新 sitelink-auto-expand（过滤嵌套 sitemap / 非页面扩展名）。`);
  await prisma.$disconnect();
}

main().catch((err) => {
  console.error("❌ 清洗异常:", err);
  process.exit(1);
});
