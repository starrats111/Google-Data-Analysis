import { buildCrawlCache } from "../src/lib/crawl-pipeline";

(async () => {
  console.log("=== 开始爬取 byfood.com ===");
  const start = Date.now();
  const cache = await buildCrawlCache("https://www.byfood.com", "byfood", "US");
  console.log("=== 耗时:", Date.now() - start, "ms ===");
  console.log("images count:", cache.images?.length);
  console.log("sitelinks count:", cache.sitelinkCandidates?.length);
  console.log("=== 图片列表 ===");
  (cache.images || []).forEach((img, i) => console.log((i + 1) + ". " + img));
  process.exit(0);
})().catch((e) => {
  console.error("ERROR:", e);
  process.exit(1);
});
