/**
 * 端到端测试：广告创建生成质量 + 速度 + 差异化
 *
 * 用法（服务器端运行）：
 *   cd /home/ubuntu/Google-Data-Analysis/crm-mvp
 *   npx tsx scripts/test-ad-generation.ts "Camplify Spain" "NASM" "Adidas"
 *
 * 验证维度：
 *   1. 速度：每个事件相对开始时间的 ms（headlines/descriptions 到达耗时）
 *   2. 质量：标题/描述条数、L2 守门是否触发、首条是否品牌锚定
 *   3. 差异化：跑两次同一商家，对比 headlines/descriptions Jaccard 相似度
 *              （目标 < 60%，越低差异化越强）
 *
 * 注意：会消耗实际 AI token 调用，不要批量乱跑
 */
import "dotenv/config";
import jwt from "jsonwebtoken";
import prisma from "../src/lib/prisma";

const JWT_SECRET = process.env.JWT_SECRET as string;
if (!JWT_SECRET) {
  console.error("缺少 JWT_SECRET 环境变量（确认在 crm-mvp 目录下运行，且 .env 已加载）");
  process.exit(1);
}
const BASE_URL = process.env.BASE_URL || "http://localhost:20050";

interface SseEvent {
  type: string;
  elapsed_ms: number;
  preview: string;
}

interface RunResult {
  label: string;
  events: SseEvent[];
  headlines: string[];
  descriptions: string[];
  totalMs: number;
  ctxInsufficient: boolean;
  detectedLanguage?: string;
  crawlStatus?: { crawl_failed?: boolean; crawl_method?: string };
  firstHeadlineMs: number; // 第一次收到 headlines 事件的耗时
  firstDescriptionMs: number;
  imagesMs: number;
  errors: string[];
}

interface CampaignTarget {
  campaignId: bigint;
  merchant: string;
  merchantUrl: string;
  country: string;
  adCreativeId: bigint;
  userId: bigint;
  username: string;
  userRole: "user" | "leader";
}

async function pickCampaign(merchantNameLike: string): Promise<CampaignTarget | null> {
  // 找一个含此商家、已有 ad_creative 的 campaign
  const merchants = await prisma.user_merchants.findMany({
    where: {
      is_deleted: 0,
      merchant_name: { contains: merchantNameLike },
    },
    take: 20,
    orderBy: { id: "desc" },
  });
  for (const m of merchants) {
    const camp = await prisma.campaigns.findFirst({
      where: { user_merchant_id: m.id, is_deleted: 0 },
      orderBy: { created_at: "desc" },
    });
    if (!camp) continue;
    const ag = await prisma.ad_groups.findFirst({ where: { campaign_id: camp.id, is_deleted: 0 } });
    if (!ag) continue;
    const ac = await prisma.ad_creatives.findFirst({ where: { ad_group_id: ag.id, is_deleted: 0 } });
    if (!ac) continue;
    const user = await prisma.users.findFirst({ where: { id: camp.user_id, is_deleted: 0 } });
    if (!user) continue;
    if (user.role !== "user" && user.role !== "leader") continue;
    return {
      campaignId: camp.id,
      merchant: m.merchant_name,
      merchantUrl: m.merchant_url || "",
      country: camp.target_country || "US",
      adCreativeId: ac.id,
      userId: user.id,
      username: user.username,
      userRole: user.role as "user" | "leader",
    };
  }
  return null;
}

function signToken(userId: bigint, username: string, role: "user" | "leader"): string {
  return jwt.sign(
    { userId: userId.toString(), username, role },
    JWT_SECRET,
    { expiresIn: "1h" },
  );
}

async function generateOnce(target: CampaignTarget, label: string): Promise<RunResult> {
  const t0 = Date.now();
  const token = signToken(target.userId, target.username, target.userRole);
  const events: SseEvent[] = [];
  const errors: string[] = [];

  const url = `${BASE_URL}/api/user/ad-creation/generate-extensions`;
  const resp = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Cookie: `user_token=${token}`,
    },
    body: JSON.stringify({
      campaign_id: target.campaignId.toString(),
      types: ["core"],
      ad_language: "en",
      keywords: [],
    }),
  });

  if (!resp.ok) {
    const text = await resp.text().catch(() => "");
    throw new Error(`[${label}] HTTP ${resp.status} — ${text.slice(0, 200)}`);
  }
  if (!resp.body) throw new Error(`[${label}] 响应无 body`);

  const reader = resp.body.getReader();
  const decoder = new TextDecoder();
  let buf = "";

  let headlines: string[] = [];
  let descriptions: string[] = [];
  let ctxInsufficient = false;
  let detectedLanguage: string | undefined;
  let crawlStatus: any;
  let firstHeadlineMs = 0;
  let firstDescriptionMs = 0;
  let imagesMs = 0;

  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let idx: number;
    while ((idx = buf.indexOf("\n\n")) >= 0) {
      const chunk = buf.slice(0, idx);
      buf = buf.slice(idx + 2);
      for (const rawLine of chunk.split("\n")) {
        const line = rawLine.trim();
        if (!line || line.startsWith(":")) continue;
        if (!line.startsWith("data: ")) continue;
        const payload = line.slice(6).trim();
        if (payload === "[DONE]") continue;
        try {
          const ev = JSON.parse(payload);
          const elapsed = Date.now() - t0;
          const preview = (() => {
            const s = JSON.stringify(ev.data);
            return s.length > 100 ? s.slice(0, 97) + "..." : s;
          })();
          events.push({ type: ev.type, elapsed_ms: elapsed, preview });
          if (ev.type === "headlines" && Array.isArray(ev.data)) {
            headlines = ev.data as string[];
            if (firstHeadlineMs === 0) firstHeadlineMs = elapsed;
          } else if (ev.type === "descriptions" && Array.isArray(ev.data)) {
            descriptions = ev.data as string[];
            if (firstDescriptionMs === 0) firstDescriptionMs = elapsed;
          } else if (ev.type === "images" && Array.isArray(ev.data) && imagesMs === 0) {
            imagesMs = elapsed;
          } else if (ev.type === "context_insufficient") {
            ctxInsufficient = true;
          } else if (ev.type === "detected_language") {
            detectedLanguage = ev.data?.code;
          } else if (ev.type === "crawl_status") {
            crawlStatus = ev.data;
          } else if (ev.type === "error") {
            errors.push(String(ev.data));
          }
        } catch (e) {
          errors.push(`JSON 解析失败: ${payload.slice(0, 50)}`);
        }
      }
    }
  }
  return {
    label,
    events,
    headlines,
    descriptions,
    totalMs: Date.now() - t0,
    ctxInsufficient,
    detectedLanguage,
    crawlStatus,
    firstHeadlineMs,
    firstDescriptionMs,
    imagesMs,
    errors,
  };
}

function jaccardSimilarity(a: string[], b: string[]): number {
  const normalize = (s: string) => s.toLowerCase().trim().replace(/\s+/g, " ");
  const sa = new Set(a.filter(Boolean).map(normalize));
  const sb = new Set(b.filter(Boolean).map(normalize));
  if (sa.size === 0 && sb.size === 0) return 0;
  if (sa.size === 0 || sb.size === 0) return 0;
  const inter = new Set([...sa].filter((x) => sb.has(x)));
  const union = new Set([...sa, ...sb]);
  return inter.size / union.size;
}

function printRun(r: RunResult) {
  console.log(`\n  [${r.label}]`);
  console.log(`  ┌─ 事件时间线 ─`);
  const importantTypes = new Set([
    "crawl_pending",
    "crawl_status",
    "detected_language",
    "headlines",
    "descriptions",
    "images",
    "sitelinks",
    "context_insufficient",
    "compliance_auto_fix",
    "compliance_warnings",
    "compliance_policy_fix",
    "error",
  ]);
  for (const e of r.events) {
    if (!importantTypes.has(e.type)) continue;
    const ms = `+${e.elapsed_ms}ms`.padStart(9);
    console.log(`  │ ${ms}  ${e.type.padEnd(28)} ${e.preview}`);
  }
  console.log(`  └─ 总耗时: ${r.totalMs}ms`);
  console.log(`     headlines 到达: +${r.firstHeadlineMs}ms (${r.headlines.length} 条)`);
  console.log(`     descriptions 到达: +${r.firstDescriptionMs}ms (${r.descriptions.length} 条)`);
  console.log(`     images 到达: +${r.imagesMs}ms`);
  if (r.crawlStatus) {
    console.log(`     爬取: method=${r.crawlStatus.crawl_method ?? "-"}, failed=${r.crawlStatus.crawl_failed ?? false}`);
  }
  if (r.detectedLanguage) console.log(`     检测语言: ${r.detectedLanguage}`);
  if (r.ctxInsufficient) console.log(`     ⚠ L2 守门触发：上下文不足`);
  if (r.errors.length > 0) {
    console.log(`     ❌ 错误:`);
    r.errors.forEach((e) => console.log(`       - ${e}`));
  }
  if (r.headlines.length > 0) {
    console.log(`\n     示例 headlines:`);
    r.headlines.slice(0, 5).forEach((h, i) => console.log(`       ${(i + 1).toString().padStart(2)}. ${h}`));
  }
  if (r.descriptions.length > 0) {
    console.log(`\n     示例 descriptions:`);
    r.descriptions.slice(0, 3).forEach((d, i) => console.log(`       ${(i + 1).toString().padStart(2)}. ${d}`));
  }
}

async function main() {
  const queries = process.argv.slice(2);
  if (queries.length === 0) {
    console.error("用法: tsx scripts/test-ad-generation.ts <商家关键字1> [商家关键字2]...");
    console.error("例:  tsx scripts/test-ad-generation.ts 'Camplify Spain' 'NASM' 'Adidas'");
    process.exit(1);
  }

  console.log("═══════════════════════════════════════════════════════════════");
  console.log("        广告创建端到端测试（质量 + 速度 + 差异化）");
  console.log("═══════════════════════════════════════════════════════════════");
  console.log(`BASE_URL: ${BASE_URL}`);
  console.log(`测试商家: ${queries.join(", ")}`);
  console.log();

  const summary: Array<{
    merchant: string;
    country: string;
    run1Total: number;
    run2Total: number;
    run1HeadlineMs: number;
    run2HeadlineMs: number;
    hlJaccard: number;
    dsJaccard: number;
    ctxBlocked: boolean;
  }> = [];

  for (const q of queries) {
    console.log(`\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
    console.log(`商家: ${q}`);
    console.log(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);

    const target = await pickCampaign(q);
    if (!target) {
      console.warn(`  × 找不到匹配的商家/广告系列：${q}`);
      continue;
    }
    console.log(`  ✓ 选中：${target.merchant} (${target.merchantUrl})`);
    console.log(`    国家=${target.country} · campaign_id=${target.campaignId} · ad_creative_id=${target.adCreativeId}`);
    console.log(`    使用用户：${target.username} (id=${target.userId}, role=${target.userRole})`);

    let r1: RunResult, r2: RunResult;
    try {
      r1 = await generateOnce(target, "Run 1 (cold)");
    } catch (err) {
      console.error(`  ❌ Run 1 失败:`, err instanceof Error ? err.message : err);
      continue;
    }
    printRun(r1);

    // 第 2 次：cache 通常已暖，模拟"重新生成"按钮
    try {
      r2 = await generateOnce(target, "Run 2 (warm)");
    } catch (err) {
      console.error(`  ❌ Run 2 失败:`, err instanceof Error ? err.message : err);
      continue;
    }
    printRun(r2);

    const hlJac = jaccardSimilarity(r1.headlines, r2.headlines);
    const dsJac = jaccardSimilarity(r1.descriptions, r2.descriptions);
    console.log(`\n  ── 差异化分析 ──`);
    console.log(`  Headlines  Run1 vs Run2 重合度: ${(hlJac * 100).toFixed(1)}%  (理想 < 60%)`);
    console.log(`  Descriptions Run1 vs Run2 重合度: ${(dsJac * 100).toFixed(1)}%  (理想 < 60%)`);
    if (hlJac >= 0.6) console.log(`  ⚠ Headlines 重合度过高 — 文案可能趋同`);
    else if (hlJac < 0.3) console.log(`  ✓ Headlines 差异化良好`);

    summary.push({
      merchant: target.merchant,
      country: target.country,
      run1Total: r1.totalMs,
      run2Total: r2.totalMs,
      run1HeadlineMs: r1.firstHeadlineMs,
      run2HeadlineMs: r2.firstHeadlineMs,
      hlJaccard: hlJac,
      dsJaccard: dsJac,
      ctxBlocked: r1.ctxInsufficient || r2.ctxInsufficient,
    });
  }

  console.log(`\n═══════════════════════════════════════════════════════════════`);
  console.log("                          总览");
  console.log("═══════════════════════════════════════════════════════════════");
  console.log("商家               国家  Run1总   Run2总   首屏Hd1  首屏Hd2  Hl相似  Ds相似  L2");
  for (const s of summary) {
    const m = s.merchant.slice(0, 18).padEnd(18);
    const c = (s.country || "").padEnd(3);
    const r1 = `${s.run1Total}ms`.padStart(8);
    const r2 = `${s.run2Total}ms`.padStart(8);
    const h1 = `${s.run1HeadlineMs}ms`.padStart(8);
    const h2 = `${s.run2HeadlineMs}ms`.padStart(8);
    const hj = `${(s.hlJaccard * 100).toFixed(0)}%`.padStart(6);
    const dj = `${(s.dsJaccard * 100).toFixed(0)}%`.padStart(6);
    const l2 = s.ctxBlocked ? "守门" : "-";
    console.log(`${m} ${c}  ${r1} ${r2}  ${h1} ${h2}  ${hj}  ${dj}  ${l2}`);
  }

  await prisma.$disconnect();
}

main().catch(async (err) => {
  console.error(err);
  await prisma.$disconnect().catch(() => {});
  process.exit(1);
});
