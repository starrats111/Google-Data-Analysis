/**
 * 一次性回填：重新巡航所有「resolved_final_url 停在 App 深链域名」的商家。
 *
 * 背景：旧巡航逻辑会把 Adjust/AppsFlyer/Branch 等 App 深链域名（如 bxfd.adj.st）
 * 误当成广告主落地页存进 resolved_final_url，加后缀后 404。新逻辑已能解开深链拿真实
 * 落地页，但旧数据需重算覆盖。本脚本仅对受污染记录重跑 resolveAffiliateLink 并写回。
 *
 * 用法（服务器上）：
 *   cd /home/ubuntu/Google-Data-Analysis/crm-mvp
 *   npx tsx scripts/d-backfill-deeplink-cruise.ts            # 干跑，仅打印将如何变化
 *   npx tsx scripts/d-backfill-deeplink-cruise.ts --apply    # 实际写回 DB
 */
import prisma from "../src/lib/prisma";
import { resolveAffiliateLink } from "../src/lib/affiliate-link-resolver";

const APPLY = process.argv.includes("--apply");

const DEEPLINK_LIKE = ["%adj.st%", "%adjust.com%", "%onelink.me%", "%app.link%", "%bnc.lt%"];

async function main() {
  const all = await prisma.user_merchants.findMany({
    where: {
      is_deleted: 0,
      OR: DEEPLINK_LIKE.map((p) => ({ resolved_final_url: { contains: p.replace(/%/g, "") } })),
    },
    select: {
      id: true, merchant_name: true, platform: true, platform_connection_id: true,
      target_country: true, tracking_link: true, campaign_link: true,
      connection_campaign_links: true, resolved_final_url: true,
    },
  });

  console.log(`命中受污染商家 ${all.length} 条；模式：${APPLY ? "APPLY 写回" : "DRY-RUN 干跑"}\n`);

  for (const m of all) {
    let affiliateUrl = "";
    const connLinks = (m.connection_campaign_links || null) as Record<string, string> | null;
    if (connLinks && m.platform_connection_id) {
      affiliateUrl = String(connLinks[String(m.platform_connection_id)] || "").trim();
    }
    if (!affiliateUrl) affiliateUrl = String(m.campaign_link || "").trim();
    if (!affiliateUrl) affiliateUrl = String(m.tracking_link || "").trim();

    const tag = `#${m.id} ${m.merchant_name} [${m.platform}]`;
    if (!affiliateUrl || !/^https?:\/\//i.test(affiliateUrl)) {
      console.log(`${tag}\n  跳过：无可用联盟链接\n`);
      continue;
    }

    const country = (m.target_country || "US").toUpperCase();
    const cruise = await resolveAffiliateLink(affiliateUrl, country, m.platform || null, { useBrowser: false });

    console.log(`${tag}`);
    console.log(`  旧 resolved_final_url: ${m.resolved_final_url}`);
    console.log(`  新 status=${cruise.status} final=${cruise.finalUrl}`);
    console.log(`  新 landing=${cruise.landingUrl} suffix=${cruise.trackingLink || "(无)"}`);

    if (APPLY) {
      await prisma.user_merchants.update({
        where: { id: m.id },
        data: {
          parent_network: cruise.parentNetwork,
          parent_blacklisted: cruise.status === "forbidden_network" ? 1 : 0,
          tracking_status: cruise.status,
          resolved_final_url: cruise.finalUrl?.slice(0, 1024) || null,
          resolve_chain: cruise.chain.slice(0, 20) as unknown as object,
          parent_checked_at: new Date(),
          parent_check_reason: (cruise.error || (cruise.status === "ok" ? "巡航通过" : cruise.status)).slice(0, 255),
        },
      });
      console.log(`  ✅ 已写回`);
    }
    console.log("");
  }

  await prisma.$disconnect();
  console.log("完成。");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
