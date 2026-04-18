/**
 * C-023 Sitelink 真实问题排查脚本（零副作用）
 *
 * 目的：在服务器上真跑一次"广告创建 → 生成 sitelinks"流程，
 *       但 **不写回 DB、不推 SSE、不触发任何发布动作**，
 *       只把 AI 原始响应 + parsed 结果 + 最终映射打到 stdout，
 *       以实证方式定位"desc1/desc2 整齐全是品牌名"的真因。
 *
 * 数据链路（与 generate-extensions/route.ts 完全一致）：
 *   campaigns(id=campaign_id, user_id) →
 *     user_merchants(id=campaign.user_merchant_id) → merchant_name + merchant_url
 *     ad_groups(campaign_id=campaign.id) →
 *       ad_creatives(ad_group_id, is_deleted=0) → final_url / crawl_cache / sitelinks
 *
 *   country = campaign.target_country
 *   ad_language = 请求时前端传入（DB 不存），脚本允许 --lang 覆盖，否则用国家默认语言
 *   merchantName = extractBrandRoot(user_merchants.merchant_name)
 *
 * 用法（服务器上跑）：
 *   cd /home/ubuntu/Google-Data-Analysis/crm-mvp
 *   SITELINK_AI_DUMP=1 npx tsx scripts/test-sitelink-flow.ts --campaign-id=<N>
 *   SITELINK_AI_DUMP=1 npx tsx scripts/test-sitelink-flow.ts --campaign-id=<N> --skip-expand
 *   SITELINK_AI_DUMP=1 npx tsx scripts/test-sitelink-flow.ts --campaign-id=<N> --lang=nl
 *   SITELINK_AI_DUMP=1 npx tsx scripts/test-sitelink-flow.ts --list-recent           # 列出最近 15 个 campaign 帮助找 id
 *
 * 参数：
 *   --campaign-id=<N>    必填（除 --list-recent 外），campaigns.id
 *   --list-recent        列出最近 15 个 campaign（id / name / target_country / merchant / final_url）后退出
 *   --skip-expand        跳过 autoExpandSitelinks（只用 cache.sitelinkCandidates 现状）
 *   --lang=<code>        覆盖广告语言（默认走国家默认语言，与真实请求中 ad_language 未传时一致）
 *   --target=<n>         目标候选数（默认 6）
 *
 * 安全承诺：只读 DB，**不写任何表、不 submit、不调 Google Ads API**。
 */
import * as fs from "fs";
import * as path from "path";

// 加载 .env（保持跟其它 scripts 一致的风格）
const envPath = path.join(process.cwd(), ".env");
if (fs.existsSync(envPath)) {
  for (const line of fs.readFileSync(envPath, "utf8").split("\n")) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)$/);
    if (m && !process.env[m[1]]) {
      process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
    }
  }
}

if (!process.env.SITELINK_AI_DUMP) process.env.SITELINK_AI_DUMP = "1";

function getArg(name: string): string | undefined {
  const pre = `--${name}=`;
  const hit = process.argv.find((a) => a.startsWith(pre));
  return hit ? hit.slice(pre.length) : undefined;
}
function hasFlag(name: string): boolean {
  return process.argv.includes(`--${name}`);
}

interface SitelinkCandidateCache {
  url: string;
  title?: string;
  description?: string;
}

async function listRecent() {
  const { default: prisma } = await import("../src/lib/prisma");
  const rows = await prisma.campaigns.findMany({
    where: { is_deleted: 0 },
    orderBy: { updated_at: "desc" },
    take: 15,
    select: {
      id: true,
      campaign_name: true,
      target_country: true,
      user_merchant_id: true,
      updated_at: true,
    },
  });
  const merchants = await prisma.user_merchants.findMany({
    where: { id: { in: rows.map((r) => r.user_merchant_id) }, is_deleted: 0 },
    select: { id: true, merchant_name: true, merchant_url: true },
  });
  const mMap = new Map(merchants.map((m) => [m.id.toString(), m]));
  console.log(
    `${"cid".padEnd(6)} ${"name".padEnd(30)} ${"country".padEnd(8)} ${"merchant".padEnd(30)} url`,
  );
  console.log("-".repeat(130));
  for (const r of rows) {
    const m = mMap.get(r.user_merchant_id.toString());
    console.log(
      `${String(r.id).padEnd(6)} ${(r.campaign_name || "").slice(0, 28).padEnd(30)} ${(r.target_country || "").padEnd(8)} ${(m?.merchant_name || "?").slice(0, 28).padEnd(30)} ${(m?.merchant_url || "").slice(0, 50)}`,
    );
  }
  await prisma.$disconnect();
}

async function runOne() {
  const idArg = getArg("campaign-id");
  if (!idArg) {
    console.error("❌ 必填参数缺失：--campaign-id=<N>  （可先 --list-recent 找 id）");
    process.exit(2);
  }
  const CAMPAIGN_ID = BigInt(idArg);
  const SKIP_EXPAND = hasFlag("skip-expand");
  const LANG_OVERRIDE = getArg("lang");
  const TARGET_COUNT = Number(getArg("target") || "6");

  const line = "=".repeat(90);
  console.log(line);
  console.log(`C-023 Sitelink 真实问题排查（只读）`);
  console.log(`  campaign_id      = ${CAMPAIGN_ID.toString()}`);
  console.log(`  skip-expand      = ${SKIP_EXPAND}`);
  console.log(`  target-count     = ${TARGET_COUNT}`);
  console.log(`  lang-override    = ${LANG_OVERRIDE ?? "(无，走国家默认)"}`);
  console.log(`  SITELINK_AI_DUMP = ${process.env.SITELINK_AI_DUMP}`);
  console.log(line);

  const { default: prisma } = await import("../src/lib/prisma");
  const { autoExpandSitelinks } = await import("../src/lib/sitelink-auto-expand");
  const { generateSitelinkTexts } = await import("../src/lib/sitelink-ai-writer");
  const { getAdMarketConfig } = await import("../src/lib/ad-market");
  const { extractBrandRoot, resolveCountryUrl } = await import("../src/lib/country-url-resolver");

  // 1. campaigns
  const campaign = await prisma.campaigns.findFirst({
    where: { id: CAMPAIGN_ID, is_deleted: 0 },
  });
  if (!campaign) {
    console.error(`❌ 未找到 campaigns.id=${CAMPAIGN_ID.toString()}（或已删除）`);
    process.exit(1);
  }

  // 2. user_merchants
  const merchant = await prisma.user_merchants.findFirst({
    where: { id: campaign.user_merchant_id, is_deleted: 0 },
  });
  if (!merchant) {
    console.error(`❌ user_merchants.id=${campaign.user_merchant_id.toString()} 不存在`);
    process.exit(1);
  }

  // 3. ad_groups + ad_creatives
  const adGroup = await prisma.ad_groups.findFirst({
    where: { campaign_id: campaign.id, is_deleted: 0 },
    select: { id: true },
  });
  const adCreative = adGroup
    ? await prisma.ad_creatives.findFirst({
      where: { ad_group_id: adGroup.id, is_deleted: 0 },
      select: { id: true, final_url: true, crawl_cache: true, sitelinks: true },
    })
    : null;

  const originalUrl = adCreative?.final_url || merchant.merchant_url || "";
  const country = campaign.target_country || "US";
  const market = getAdMarketConfig(country);

  // 4. 国别 URL 解析（与 route.ts 完全一致 — 不写 DB，只算 URL）
  const resolverResult = await resolveCountryUrl(originalUrl, country);
  const merchantUrl = resolverResult.finalUrl || originalUrl;
  const brand = extractBrandRoot(merchant.merchant_name || "");

  const cache = (adCreative?.crawl_cache as unknown) as
    | { sitelinkCandidates?: SitelinkCandidateCache[] }
    | null
    | undefined;

  const existing = (cache?.sitelinkCandidates || []).map((s) => ({
    url: s.url,
    title: s.title,
    description: s.description,
  }));

  console.log(`\n[Step 1] 业务链路解析`);
  console.log(`  campaign.id / name      = ${campaign.id.toString()} / ${campaign.campaign_name ?? "(无名)"}`);
  console.log(`  campaign.target_country = ${country}`);
  console.log(`  user_merchants.id       = ${merchant.id.toString()}`);
  console.log(`  merchant_name (raw)     = "${merchant.merchant_name}"`);
  console.log(`  brand (extractBrandRoot)= "${brand}"`);
  console.log(`  user_merchants.url      = ${merchant.merchant_url}`);
  console.log(`  ad_creative.id          = ${adCreative?.id?.toString() ?? "(无，该 campaign 下无 creative)"}`);
  console.log(`  ad_creative.final_url   = ${adCreative?.final_url ?? "(无)"}`);
  console.log(`  resolveCountryUrl       = switched=${resolverResult.switched} reason=${resolverResult.reason}`);
  console.log(`  → 使用 merchantUrl      = ${merchantUrl}`);
  console.log(`  cache.sitelinkCandidates= ${existing.length} 条`);
  if (existing.length > 0) {
    for (const s of existing.slice(0, 8)) {
      console.log(
        `    - ${s.url}  | title="${(s.title || "").slice(0, 60)}" | desc="${(s.description || "").slice(0, 80)}"`,
      );
    }
  }
  console.log(`  ad_creative.sitelinks (当前DB) = ${Array.isArray(adCreative?.sitelinks) ? (adCreative!.sitelinks as unknown[]).length : 0} 条（仅展示，不会修改）`);

  // 5. 扩源
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
        `    - ${s.url}  | title="${(s.title || "").slice(0, 60)}" | desc="${(s.description || "").slice(0, 80)}"`,
      );
    }
  } else {
    console.log(`\n[Step 2] 已 --skip-expand，直接使用 cache 现状 (${existing.length} 条)`);
  }

  // 6. 去重（与 generateSitelinksOnly 里一致）
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
    console.warn(`\n⚠️  候选为 0，AI 不会被调用。问题在"发现/扩源"阶段，请看 crawl-pipeline / sitelink-auto-expand。`);
    await prisma.$disconnect();
    return;
  }

  // 7. 调 AI
  const aiInputs = unique.map((s) => ({
    url: s.url,
    pageTitle: s.title,
    pageDescription: s.description,
  }));
  const lang = LANG_OVERRIDE || market.languageCode;
  console.log(`\n[Step 4] 调 generateSitelinkTexts`);
  console.log(`  brand    = ${brand}`);
  console.log(`  country  = ${country}`);
  console.log(`  language = ${lang}`);
  console.log(`  (AI raw / parsed 会以 [SitelinkAI-RAW] [SitelinkAI-PARSED] 打到 stderr)`);

  const t0 = Date.now();
  const written = await generateSitelinkTexts(aiInputs, {
    brandRoot: brand,
    country,
    languageCode: lang,
  });
  const cost = Date.now() - t0;

  // 8. 最终结果
  console.log(`\n[Step 5] AI 生成结果 (${written.length} 条，耗时 ${cost}ms)：`);
  console.log(
    `${"#".padEnd(3)} ${"URL".padEnd(50)} ${"title".padEnd(26)} ${"desc1".padEnd(36)} desc2`,
  );
  console.log("-".repeat(160));
  written.forEach((w, i) => {
    console.log(
      `${String(i + 1).padEnd(3)} ${w.url.slice(0, 48).padEnd(50)} ${(w.title || "").slice(0, 24).padEnd(26)} ${(w.desc1 || "").slice(0, 34).padEnd(36)} ${w.desc2 || ""}`,
    );
  });

  // 9. 诊断统计
  const brandLc = brand.toLowerCase();
  const brandFallbackCount = written.filter(
    (w) => (w.desc1 || "").trim().toLowerCase() === brandLc || (w.desc2 || "").trim().toLowerCase() === brandLc,
  ).length;
  console.log(`\n[Stat]`);
  console.log(`  desc1 或 desc2 = "${brand}" 的条目数：${brandFallbackCount}/${written.length}`);
  console.log(`  空 desc1 / desc2：${written.filter((w) => !w.desc1 || !w.desc2).length}/${written.length}`);
  if (brandFallbackCount > 0) {
    console.warn(`  ⚠️  存在 brand 兜底。请看 stderr 里 [SitelinkAI-RAW] / [SitelinkAI-PARSED] 核对 AI 真实返回。`);
  }

  console.log(`\n[Safety] 本脚本未修改任何表，ad_creatives.sitelinks 维持原状。`);
  await prisma.$disconnect();
}

async function main() {
  if (hasFlag("list-recent")) {
    await listRecent();
    return;
  }
  await runOne();
}

main().catch(async (err) => {
  console.error("❌ 脚本异常:", err instanceof Error ? err.stack || err.message : err);
  try {
    const { default: prisma } = await import("../src/lib/prisma");
    await prisma.$disconnect();
  } catch {}
  process.exit(1);
});
