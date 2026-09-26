/**
 * D-362 只读核查：现在这一刻，Hermes 托管门对每条在跑的托管系列是开还是关。
 *
 * 为什么要有这个脚本：门的结论是「Hermes 活没活着」，而这个判断没有界面。
 * 出问题时（比如 01 2026-09-26 报的 wj07 四条广告停不掉）只能靠翻 nginx 日志倒推，
 * 上线后也需要一眼看清：阈值是多少、上次回推什么时候、哪些系列因此解锁了。
 *
 * 只读：不写库、不调 Google Ads、不碰任何广告状态。
 *
 * 用法：npx tsx scripts/d362-verify-hermes-gate.ts
 */
import { loadEnvFromProjectRoot } from "./load-env-from-dotenv-file";
loadEnvFromProjectRoot();

import prisma from "@/lib/prisma";
import { getHermesStatusGate } from "@/lib/hermes-liveness";

const cst = (d: Date | null) =>
  d ? new Intl.DateTimeFormat("sv-SE", {
    timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", hour12: false,
  }).format(d) : "—";

async function main() {
  const gate = await getHermesStatusGate();
  console.log("===== D-362 Hermes 状态主权门 =====");
  console.log(`判定        : ${gate.alive ? "Hermes 在管（CRM 不写状态）" : "Hermes 已静默（主权回到 CRM，可以停）"}`);
  console.log(`上次回推    : ${cst(gate.lastSeenAt)} (北京时间)`);
  console.log(`已静默      : ${gate.silentHours === null ? "从未见过 Hermes" : gate.silentHours + " 小时"}`);
  console.log(`判死阈值    : ${gate.staleHours} 小时`);
  console.log(`判据来源    : ${gate.source === "heartbeat" ? "D-362 心跳键" : gate.source === "fallback" ? "兜底（campaigns.hermes_managed_at 最大值，偏保守）" : "无任何 Hermes 痕迹"}`);

  const rows = await prisma.campaigns.findMany({
    where: { hermes_managed_at: { not: null }, is_deleted: 0, google_status: "ENABLED" },
    select: {
      id: true, campaign_name: true, hermes_managed_at: true, daily_budget: true,
      users: { select: { username: true } },
    },
    orderBy: { hermes_managed_at: "desc" },
  });
  const total = await prisma.campaigns.count({ where: { hermes_managed_at: { not: null }, is_deleted: 0 } });

  console.log(`\n全库挂着托管闩的系列：${total} 条，其中 ENABLED（受这道门影响、钱还在烧的）：${rows.length} 条`);
  for (const c of rows) {
    console.log(`  [${c.users?.username ?? "?"}] #${c.id} ${c.campaign_name} 预算$${c.daily_budget} 托管起于 ${cst(c.hermes_managed_at)}`);
  }
  console.log(`\n结论：这 ${rows.length} 条现在在 CRM 里${gate.alive ? "仍然停不了（Hermes 还在管，符合 D-247 原意）" : "可以自己停了"}。`);
  await prisma.$disconnect();
}

main().catch(async (e) => {
  console.error(e);
  await prisma.$disconnect();
  process.exit(1);
});
