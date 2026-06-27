/**
 * 一次性回填：重新巡航所有「resolved_final_url 停在 EngageVantage/UltraInfluence 点击中转域名」的商家。
 *
 * 背景：旧巡航逻辑没识别 EV/MUI 的发布者点击中转域名（pub.engagevantage.com / pub.ultrainfluence.com），
 * 纯 HTTP 跟不动其 JS 跳转就停在中转域名上，把「联盟追踪/中转链接」误当成广告主落地页存进
 * resolved_final_url（加后缀后指向中转域名而非广告主）。新逻辑已能：① 用真实浏览器跟随拿到完整广告主
 * 落地页（广告主域名 + 追踪 query）；② 浏览器不可用时退而解 url= 参数里的静态广告主 URL。
 * 但旧脏数据需重算覆盖——本脚本仅对受污染记录重跑 resolveAffiliateLink（开浏览器兜底）并写回。
 *
 * 精准筛选：先按 resolved_final_url 含 engagevantage.com / ultrainfluence.com 粗筛，再用「主机名」二次过滤，
 * 绝不误伤把 engagevantage/ultrainfluence 写进 utm_campaign 等参数值的正常落地页。
 *
 * 用法（服务器上，低配机务必串行、勿并发其它重任务）：
 *   cd /home/ubuntu/Google-Data-Analysis/crm-mvp
 *   npx tsx scripts/d-backfill-evmui-cruise.ts            # 干跑，仅打印将如何变化
 *   npx tsx scripts/d-backfill-evmui-cruise.ts --apply    # 实际写回 DB
 */
import prisma from "../src/lib/prisma";
import { resolveAffiliateLink } from "../src/lib/affiliate-link-resolver";

const APPLY = process.argv.includes("--apply");

// 与 affiliate-link-resolver 的 NETWORK_CLICK_HOST_PATTERNS 保持一致（仅匹配主机名）
const NETWORK_CLICK_HOST_PATTERNS: RegExp[] = [/(^|\.)engagevantage\.com$/i, /(^|\.)ultrainfluence\.com$/i];
function isNetworkClickHost(host: string): boolean {
  return NETWORK_CLICK_HOST_PATTERNS.some((re) => re.test(host));
}

/** resolved_final_url 是否「停在」EV/MUI 点击中转主机名上（仅看 host，过滤掉只是参数里出现网络名的正常落地页） */
function stuckOnNetworkClick(resolvedFinalUrl: string | null): boolean {
  if (!resolvedFinalUrl) return false;
  try {
    return isNetworkClickHost(new URL(resolvedFinalUrl).hostname);
  } catch {
    return false;
  }
}

async function main() {
  // 粗筛：resolved_final_url 含网络域名（带 .com，避免命中 utm_campaign=EngageVantage 这类纯品牌名值）
  const candidates = await prisma.user_merchants.findMany({
    where: {
      is_deleted: 0,
      OR: [
        { resolved_final_url: { contains: "engagevantage.com" } },
        { resolved_final_url: { contains: "ultrainfluence.com" } },
      ],
    },
    select: {
      id: true, merchant_name: true, platform: true, platform_connection_id: true,
      target_country: true, tracking_link: true, campaign_link: true,
      connection_campaign_links: true, resolved_final_url: true,
    },
  });

  // 精筛：仅保留 resolved_final_url「主机名」确实停在中转域名的（受污染记录）
  const polluted = candidates.filter((m) => stuckOnNetworkClick(m.resolved_final_url));

  console.log(
    `粗筛命中 ${candidates.length} 条；主机名精筛后受污染 ${polluted.length} 条；模式：${APPLY ? "APPLY 写回" : "DRY-RUN 干跑"}\n`,
  );

  let ok = 0;
  let failed = 0;
  let skipped = 0;

  for (const m of polluted) {
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
      skipped++;
      continue;
    }

    const country = (m.target_country || "US").toUpperCase();
    // 开浏览器兜底：EV/MUI 靠 JS 跳转，HTTP 停在中转域名时用真实浏览器跟到广告主落地页（受 puppeteer 信号量限并发）
    const cruise = await resolveAffiliateLink(affiliateUrl, country, m.platform || null, { browserFallback: true });

    console.log(`${tag}`);
    console.log(`  旧 resolved_final_url: ${m.resolved_final_url}`);
    console.log(`  新 status=${cruise.status} final=${cruise.finalUrl}`);
    console.log(`  新 landing=${cruise.landingUrl} suffix=${cruise.trackingLink || "(无)"} browser=${cruise.usedBrowser}`);

    const stillStuck = stuckOnNetworkClick(cruise.finalUrl);
    if (cruise.status === "ok" && !stillStuck) ok++;
    else failed++;
    if (stillStuck) console.log(`  ⚠️ 仍停在中转域名（浏览器也没跟到广告主，可能需配置对应国家代理或稍后重试）`);

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

  console.log(`完成。受污染 ${polluted.length}：成功跟到广告主 ${ok}，仍失败 ${failed}，无链接跳过 ${skipped}。`);
  if (!APPLY && polluted.length > 0) console.log(`（以上为干跑，确认无误后加 --apply 写回 DB）`);
  await prisma.$disconnect();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
