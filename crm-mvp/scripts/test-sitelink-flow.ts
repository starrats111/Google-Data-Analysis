/**
 * C-023 Sitelink 真实问题排查脚本（零副作用）
 *
 * 目的：在服务器上真跑一次"广告创建 → 生成 sitelinks"流程，
 *       但 **不写回 DB、不推 SSE、不触发任何发布动作**，
 *       只把 AI 原始响应 + parsed 结果 + 最终映射打到 stdout，让人能直接看到真相。
 *
 * 相当于 `generateSitelinksOnly` 的只读复刻版，等价于前端"重新爬取"按钮背后的业务，
 * 但 AI 调用走 SITELINK_AI_DUMP=1 开关，把原始 raw 全文写到 stderr（方便 pipe / tee）。
 *
 * 用法（服务器上跑）：
 *   cd /home/ubuntu/ad-automation/crm-mvp
 *   SITELINK_AI_DUMP=1 npx tsx scripts/test-sitelink-flow.ts --id=402
 *   SITELINK_AI_DUMP=1 npx tsx scripts/test-sitelink-flow.ts --id=402 --skip-expand  # 只用现有 cache
 *   SITELINK_AI_DUMP=1 npx tsx scripts/test-sitelink-flow.ts --id=402 --lang=nl      # 强制荷兰语
 *
 * 参数：
 *   --id=<number>    必填，ad_creatives.id
 *   --skip-expand    跳过 autoExpandSitelinks（只用 cache.sitelinkCandidates 现状，速度快）
 *   --lang=<code>    覆盖广告语言（默认读 ad_creatives.ad_language_code / country）
 *   --target=<n>     目标候选数（默认 6）
 *   --brand=<name>   覆盖 brand（默认读 ad_creatives.merchant_name）
 *
 * 安全承诺：此脚本只读 DB，**不写任何表、不 submit、不调 Google Ads API**。
 */
import * as fs from "fs";
import * as path from "path";

// 先加载 .env（保持跟其它 scripts 一致的风格）
const envPath = path.join(process.cwd(), ".env");
if (fs.existsSync(envPath)) {
  for (const line of fs.readFileSync(envPath, "utf8").split("\n")) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)$/);
    if (m && !process.env[m[1]]) {
      process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
    }
  }
}

// 确保 AI 诊断 dump 开启（若调用方没设，则脚本默认开）
if (!process.env.SITELINK_AI_DUMP) process.env.SITELINK_AI_DUMP = "1";

function getArg(name: string): string | undefined {
  const pre = `--${name}=`;
  const hit = process.argv.find((a) => a.startsWith(pre));
  return hit ? hit.slice(pre.length) : undefined;
}
function hasFlag(name: string): boolean {
  return process.argv.includes(`--${name}`);
}

const idArg = getArg("id");
if (!idArg) {
  console.error("❌ 必填参数缺失：--id=<ad_creatives.id>");
  process.exit(2);
}
const TARGET_ID = BigInt(idArg);
const SKIP_EXPAND = hasFlag("skip-expand");
const LANG_OVERRIDE = getArg("lang");
const TARGET_COUNT = Number(getArg("target") || "6");
const BRAND_OVERRIDE = getArg("brand");

interface SitelinkCandidateCache {
  url: string;
  title?: string;
  description?: string;
}

async function main() {
  const line = "=".repeat(80);
  console.log(line);
  console.log(`C-023 Sitelink 真实问题排查（只读）`);
  console.log(`  ad_creatives.id = ${TARGET_ID.toString()}`);
  console.log(`  skip-expand     = ${SKIP_EXPAND}`);
  console.log(`  target-count    = ${TARGET_COUNT}`);
  console.log(`  SITELINK_AI_DUMP= ${process.env.SITELINK_AI_DUMP}`);
  console.log(line);

  const { default: prisma } = await import("../src/lib/prisma");
  const { autoExpandSitelinks } = await import("../src/lib/sitelink-auto-expand");
  const { generateSitelinkTexts } = await import("../src/lib/sitelink-ai-writer");
  const { getAdMarketConfig } = await import("../src/lib/ad-market");

  // ──────────────────────────────────────────
  // 1. 读 ad_creatives + crawl_cache
  // ──────────────────────────────────────────
  const ac = await prisma.ad_creatives.findFirst({
    where: { id: TARGET_ID, is_deleted: 0 },
    select: {
      id: true,
      merchant_name: true,
      final_url: true,
      ad_language_code: true,
      sitelinks: true,
      crawl_cache: true,
      ad_campaigns: { select: { country_code: true } },
    },
  });
  if (!ac) {
    console.error(`❌ 未找到 ad_creatives.id=${TARGET_ID.toString()}`);
    process.exit(1);
  }

  const country = ac.ad_campaigns?.country_code || "US";
  const brand = BRAND_OVERRIDE || ac.merchant_name || "Brand";
  const merchantUrl = ac.final_url || "";
  const cache = (ac.crawl_cache as unknown) as
    | { sitelinkCandidates?: SitelinkCandidateCache[] }
    | null
    | undefined;

  const existing = (cache?.sitelinkCandidates || []).map((s) => ({
    url: s.url,
    title: s.title,
    description: s.description,
  }));

  console.log(`\n[Step 1] 商家元数据`);
  console.log(`  merchant_name       = ${brand}`);
  console.log(`  final_url           = ${merchantUrl}`);
  console.log(`  country             = ${country}`);
  console.log(`  ad_language_code    = ${ac.ad_language_code || "(未设置，用国家默认)"}`);
  console.log(`  cache.sitelinkCandidates = ${existing.length} 条`);
  if (existing.length > 0) {
    for (const s of existing.slice(0, 8)) {
      console.log(
        `    - ${s.url}  | title="${(s.title || "").slice(0, 60)}"  | desc="${(s.description || "").slice(0, 80)}"`,
      );
    }
  }
  console.log(`  sitelinks(当前DB)    = ${Array.isArray(ac.sitelinks) ? (ac.sitelinks as unknown[]).length : 0} 条（仅显示，不会修改）`);

  // ──────────────────────────────────────────
  // 2. 扩源（模拟 generateSitelinksOnly.autoExpandSitelinks）
  // ──────────────────────────────────────────
  let expanded = existing;
  if (!SKIP_EXPAND) {
    console.log(`\n[Step 2] 调 autoExpandSitelinks（target=${TARGET_COUNT}）…`);
    const t0 = Date.now();
    expanded = await autoExpandSitelinks({
      merchantUrl,
      country,
      existing,
      targetCount: TARGET_COUNT,
    });
    console.log(`  扩源耗时 ${Date.now() - t0}ms，得到 ${expanded.length} 条`);
    for (const s of expanded) {
      console.log(
        `    - ${s.url}  | title="${(s.title || "").slice(0, 60)}"  | desc="${(s.description || "").slice(0, 80)}"`,
      );
    }
  } else {
    console.log(`\n[Step 2] 已 --skip-expand，直接使用 cache 现状 (${existing.length} 条)`);
  }

  // 去重（与 generateSitelinksOnly 里一致的归一化）
  const unique: typeof expanded = [];
  const seen = new Set<string>();
  for (const s of expanded) {
    const norm = s.url.replace(/\/$/, "").replace(/^http:/, "https:").toLowerCase();
    if (seen.has(norm)) continue;
    seen.add(norm);
    unique.push(s);
    if (unique.length >= 8) break;
  }
  console.log(`\n[Step 3] 去重后候选 ${unique.length} 条（送 AI）：`);
  unique.forEach((s, i) => {
    console.log(`  [${i + 1}] ${s.url}`);
    if (s.title) console.log(`        title: ${s.title.slice(0, 100)}`);
    if (s.description) console.log(`        desc : ${s.description.slice(0, 120)}`);
  });

  if (unique.length === 0) {
    console.warn(`\n⚠️  候选为 0，AI 不会被调用。问题在"发现/扩源"阶段，请先检查 crawl-pipeline / sitelink-auto-expand。`);
    await prisma.$disconnect();
    return;
  }

  // ──────────────────────────────────────────
  // 3. 调 AI（SITELINK_AI_DUMP=1 会把 raw 全文 + parsed 打到 stderr）
  // ──────────────────────────────────────────
  const market = getAdMarketConfig(country);
  const aiInputs = unique.map((s) => ({
    url: s.url,
    pageTitle: s.title,
    pageDescription: s.description,
  }));

  console.log(`\n[Step 4] 调 generateSitelinkTexts`);
  console.log(`  brand      = ${brand}`);
  console.log(`  country    = ${country}`);
  console.log(`  language   = ${LANG_OVERRIDE || ac.ad_language_code || market.languageCode}`);
  console.log(`  (AI raw 会以 [SitelinkAI-RAW] 前缀打到 stderr，可用 2>&1 合并)`);

  const t0 = Date.now();
  const written = await generateSitelinkTexts(aiInputs, {
    brandRoot: brand,
    country,
    languageCode: LANG_OVERRIDE || ac.ad_language_code || market.languageCode,
  });
  const cost = Date.now() - t0;

  // ──────────────────────────────────────────
  // 4. 最终结果对照表
  // ──────────────────────────────────────────
  console.log(`\n[Step 5] AI 生成结果 (${written.length} 条，耗时 ${cost}ms)：`);
  console.log(`${"#".padEnd(3)} ${"URL".padEnd(60)} ${"title".padEnd(26)} ${"desc1".padEnd(36)} desc2`);
  console.log("-".repeat(160));
  written.forEach((w, i) => {
    console.log(
      `${String(i + 1).padEnd(3)} ${w.url.slice(0, 58).padEnd(60)} ${(w.title || "").slice(0, 24).padEnd(26)} ${(w.desc1 || "").slice(0, 34).padEnd(36)} ${w.desc2 || ""}`,
    );
  });

  // 统计：desc1/desc2 是否整条都等于 brand（暴露 fallback 现象）
  const brandCount = written.filter(
    (w) => (w.desc1 || "").trim().toLowerCase() === brand.toLowerCase() || (w.desc2 || "").trim().toLowerCase() === brand.toLowerCase(),
  ).length;
  console.log(`\n[Stat] desc1 或 desc2 = "${brand}" 的条目数：${brandCount}/${written.length}`);
  if (brandCount > 0) {
    console.warn(`  ⚠️  存在 brand 兜底。请检查 stderr 里 [SitelinkAI-RAW] / [SitelinkAI-PARSED] 日志核对 AI 真实返回。`);
  }

  console.log(`\n[Safety] 本脚本未修改任何表，ad_creatives.sitelinks 维持原状。`);
  await prisma.$disconnect();
}

main().catch(async (err) => {
  console.error("❌ 脚本异常:", err instanceof Error ? err.stack || err.message : err);
  try {
    const { default: prisma } = await import("../src/lib/prisma");
    await prisma.$disconnect();
  } catch {}
  process.exit(1);
});
