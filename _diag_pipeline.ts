/**
 * 诊断：用新部署的代理出口校验 + sid 实时换池逻辑，重跑 buildCrawlCache(camplify.es, ES)
 *
 * 用法：
 *   cd ~/Google-Data-Analysis/crm-mvp && set -a && source .env && set +a
 *   npx tsx ../_diag_pipeline.ts
 */
import { buildCrawlCache } from "./crm-mvp/src/lib/crawl-pipeline";

async function main() {
  console.log("======== buildCrawlCache(camplify.es, ES) ========");
  const t0 = Date.now();
  const cache = await buildCrawlCache(
    "https://www.camplify.es/",
    "Camplify",
    "ES",
    undefined,
    {},
  );
  console.log(`\n======== 完成 ========`);
  console.log(`耗时: ${Date.now() - t0}ms`);
  console.log(`pageText 长度: ${cache.pageText.length}`);
  console.log(`crawlMethod: ${cache.crawlMethod}`);
  console.log(`crawlFailed: ${cache.crawlFailed}`);
  console.log(`features: ${cache.features.length} 条`);
  console.log(`images: ${cache.images.length} 张`);
  console.log(`links: ${cache.links.length} 条`);
  console.log(`qualityScore: ${cache.crawlQualityScore}`);
  console.log(`qualityIssues: ${JSON.stringify(cache.crawlQualityIssues)}`);
  console.log(`\npageText 前 500 字:\n${cache.pageText.slice(0, 500)}`);
  console.log(`\nfeatures:`);
  for (const f of cache.features.slice(0, 10)) console.log(`  - ${f}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
