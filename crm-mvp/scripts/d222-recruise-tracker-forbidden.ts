/**
 * D-222 一次性重巡：把被判 tracker_forbidden 的商家按「新的出口国选取」重跑一遍。
 *
 * 背景见 设计方案.md D-222：商家 target_country 149 万行里只有 5 千行有值，巡航原先一律
 * 兜底美国出口，去点带地区门禁的非美国联盟链接必然 403（collabglow 实测 US/JP 100% 403、
 * GB 200），被判 tracker_forbidden，换链接页标红「失效」。修复后取国改成
 * 商家 target_country → 其在投系列的 campaigns.target_country → US。
 *
 * cron 巡航有 24h 重试窗口，刚巡过的商家当天不会再被选中，故用本脚本立即重跑验证。
 * 走 resolveMerchantNow（与「换链接管理」页手动同步同一入口），写回全部经 Prisma。
 *
 * 用法：
 *   cd /home/ubuntu/Google-Data-Analysis/crm-mvp
 *   npx tsx scripts/d222-recruise-tracker-forbidden.ts            # 干跑，只打印将用哪个出口国
 *   npx tsx scripts/d222-recruise-tracker-forbidden.ts --apply    # 实际重巡并写回
 *   npx tsx scripts/d222-recruise-tracker-forbidden.ts --apply --ids=78115
 */
import { loadEnvFromProjectRoot } from "./load-env-from-dotenv-file";

const APPLY = process.argv.includes("--apply");
const IDS = (process.argv.find((a) => a.startsWith("--ids=")) || "")
  .replace("--ids=", "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

async function main() {
  // 先注入 .env（prisma client 在 import 时即按 DATABASE_URL 构造连接）
  loadEnvFromProjectRoot();
  const { default: prisma } = await import("../src/lib/prisma");
  const { resolveMerchantNow } = await import("../src/lib/suffix-engine/link-sync");
  const { getMerchantCampaignCountries, pickCruiseCountry } = await import(
    "../src/lib/suffix-engine/merchant-country"
  );

  const targets = await prisma.user_merchants.findMany({
    where: {
      is_deleted: 0,
      ...(IDS.length > 0
        ? { id: { in: IDS.map((s) => BigInt(s)) } }
        : { tracking_status: "tracker_forbidden" }),
    },
    select: { id: true, user_id: true, merchant_name: true, platform: true, target_country: true },
    orderBy: { id: "asc" },
  });

  if (targets.length === 0) {
    console.log("没有需要重巡的商家。");
    await prisma.$disconnect();
    return;
  }

  const campaignCountries = await getMerchantCampaignCountries(targets.map((m) => m.id));

  console.log(`待重巡 ${targets.length} 个商家${APPLY ? "" : "（干跑）"}：\n`);
  let ok = 0;
  let stillBad = 0;

  for (const m of targets) {
    const country = pickCruiseCountry(m.target_country, campaignCountries.get(String(m.id)));
    const head = `${m.id}  ${m.platform || "-"}  ${(m.merchant_name || "").slice(0, 24).padEnd(24)}  出口国=${country}`;

    if (!APPLY) {
      console.log(`${head}   （商家国家=${m.target_country || "空"}，系列国=${campaignCountries.get(String(m.id)) || "无"}）`);
      continue;
    }

    try {
      const r = await resolveMerchantNow(m.id, m.user_id);
      const status = r?.trackingStatus || "无返回";
      if (status === "ok") ok++;
      else stillBad++;
      console.log(`${head}   → ${status}  上级联盟=${r?.parentNetwork || "未识别"}`);
    } catch (e) {
      stillBad++;
      console.log(`${head}   → 异常：${e instanceof Error ? e.message : String(e)}`);
    }
  }

  if (APPLY) console.log(`\n完成：巡航通过 ${ok}，仍失败 ${stillBad}。`);
  else console.log(`\n（以上为干跑，确认出口国无误后加 --apply 实际重巡）`);

  await prisma.$disconnect();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
