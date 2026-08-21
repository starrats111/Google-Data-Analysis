/**
 * D-260 补跑 watchlist 扫描（绕开 HTTP cron 的长请求断连问题，直接进程内调用）。
 * 告警有 (user, creative, date) 唯一键 + skipDuplicates，重复跑安全。
 */
process.loadEnvFile(".env");

async function main() {
  const { scanAllWatchlists } = await import("../src/lib/atc-watchlist-scanner");
  const { syncAtcRecommendations } = await import("../src/lib/atc-recommendation-sync");

  const result = await scanAllWatchlists();
  console.log(`[${new Date().toISOString()}] scan 完成:`, JSON.stringify(result));

  try {
    const rec = await syncAtcRecommendations({ dryRun: false });
    console.log(`[${new Date().toISOString()}] rec-sync 完成:`, JSON.stringify(rec));
  } catch (e) {
    console.error("rec-sync 失败:", String(e).slice(0, 300));
  }
  process.exit(0);
}

main().catch((e) => {
  console.error("scan 失败:", e);
  process.exit(1);
});
