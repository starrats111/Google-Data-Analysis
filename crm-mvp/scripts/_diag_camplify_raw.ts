/**
 * 诊断：直接调 crawlWithPuppeteerFull，看返回的 html 是不是真的含 body 文字
 * （buildCrawlCache 链路太长，先排除是 htmlToText 提取问题）
 *
 * 用法：cd ~/Google-Data-Analysis/crm-mvp && set -a && source .env && set +a && npx tsx scripts/_diag_camplify_raw.ts
 */
import { crawlWithPuppeteerFull } from "@/lib/crawler";
import { getHttpProxyUrlForCountry } from "@/lib/crawl-proxy";

async function main() {
  console.log("======== 取 ES 代理 ========");
  const proxyUrl = await getHttpProxyUrlForCountry("ES");
  if (!proxyUrl) { console.log("代理为 null"); return; }
  console.log("======== crawlWithPuppeteerFull(camplify.es/) ========");
  const t0 = Date.now();
  const r = await crawlWithPuppeteerFull("https://www.camplify.es/", 35000, proxyUrl);
  console.log(`耗时 ${Date.now() - t0}ms`);
  if (!r) { console.log("Puppeteer 返回 null"); return; }
  console.log(`html: ${r.html.length} bytes`);

  // 用 htmlToText 同款规则提取
  let t = r.html;
  t = t.replace(/<head[\s\S]*?<\/head>/i, " ");
  t = t.replace(/<script[\s\S]*?<\/script>/gi, " ");
  t = t.replace(/<noscript[\s\S]*?<\/noscript>/gi, " ");
  t = t.replace(/<style[\s\S]*?<\/style>/gi, " ");
  t = t.replace(/<svg[\s\S]*?<\/svg>/gi, " ");
  t = t.replace(/<[^>]+>/g, " ");
  t = t.replace(/\s+/g, " ").trim();
  console.log(`htmlToText 结果长度: ${t.length}`);
  console.log(`前 400 字: ${t.slice(0, 400)}`);

  // 看一下 body 标签开始后 4000 字内的 raw HTML 节选
  const bodyMatch = r.html.match(/<body[^>]*>([\s\S]{0,4000})/i);
  console.log(`\nbody 标签开始后 4000 字（raw HTML）:\n${bodyMatch ? bodyMatch[1] : "未找到 body"}`);
}

main().catch(err => { console.error(err); process.exit(1); });
