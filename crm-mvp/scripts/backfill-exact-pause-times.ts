/**
 * D-245 一次性修正：用 Google Ads change_event（保留 30 天）把存量近似暂停时间
 * （pause_source = backfill / sync）替换为精确暂停时间（→ change_history）。
 * 超出 30 天窗口或查不到暂停事件的行保持近似值不动（UI 继续标 ≈）。
 *
 *   npx tsx scripts/backfill-exact-pause-times.ts          # 试跑（不写库，输出变更明细）
 *   npx tsx scripts/backfill-exact-pause-times.ts --apply  # 实际写库
 */
import { loadEnvFromProjectRoot } from "./load-env-from-dotenv-file";

async function main() {
  loadEnvFromProjectRoot();
  const { refinePauseTimesFromChangeHistory } = await import("../src/lib/google-ads/change-history");
  const apply = process.argv.includes("--apply");
  console.log(`模式：${apply ? "实际写库" : "试跑（--apply 才写库）"}`);

  const r = await refinePauseTimesFromChangeHistory({
    sources: ["backfill", "sync"],
    recentDays: 45,   // 近似值可能偏离真实暂停日，放宽扫描范围
    lookbackDays: 29, // change_event 上限 30 天
    dryRun: !apply,
    log: (m) => console.log(m),
  });

  console.log(`\n扫描 ${r.scanned} 条，查询 ${r.cidsQueried} 个 CID，命中精确时间 ${r.updated} 条，失败 ${r.errors} 个 CID`);
  for (const c of r.changes.slice(0, 50)) {
    console.log(`  campaign#${c.campaignId} gcid=${c.gcid}  ${c.before}  →  ${c.after}`);
  }
  if (r.changes.length > 50) console.log(`  ...（共 ${r.changes.length} 条变更，仅显示前 50）`);
  process.exit(0);
}

main().catch((e) => { console.error(e); process.exit(1); });
