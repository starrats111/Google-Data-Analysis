/**
 * D-278：节点清单商家 AI 品类打标（两阶段，07 拍板：AI 先打 → 07 确认对照表 → 再刷库）
 *
 * propose 阶段（只读，不动库）：
 *   取节点清单（merchant_recommendations source=node）对应的 user_merchants 行，
 *   凡品类为空/Others/不在统一品类表（CATEGORY_CN）里的，让 AI 从封闭品类表中选一个；
 *   AI 拿不准必须回 Unknown（质量闸：不确定不硬塞）。产出对照表 JSON + Markdown 给 07 确认。
 *
 * apply 阶段（07 确认后执行）：
 *   按对照表刷 user_merchants.category（只动 category_manual=0 的行；刷后置 category_manual=1，
 *   语义=经 07 人工确认的标签，平台同步不再覆盖）。刷前备份原值 JSON，可整批还原。
 *
 * 用法（生产服务器 crm-mvp 目录）：
 *   npx tsx scripts/d278-ai-tag-categories.ts --phase=propose --node=black_friday
 *   npx tsx scripts/d278-ai-tag-categories.ts --phase=apply --file=/tmp/d278_tag_proposal_confirmed.json
 */
process.loadEnvFile(".env");
import { readFileSync, writeFileSync } from "fs";

const args = new Map<string, string>();
for (const a of process.argv.slice(2)) {
  const m = a.match(/^--([^=]+)=(.*)$/);
  if (m) args.set(m[1], m[2]);
}
const PHASE = args.get("phase") || "propose";
const NODE_CODE = args.get("node") || "black_friday";
const FILE = args.get("file") || "";
const AI_SCENE = "data_insight"; // 未配置时 ai-service 自动降级 ad_copy 场景（D-162 机制）
const BATCH = 20;

const log = (msg: string) => console.log(`[${new Date().toISOString()}] ${msg}`);

interface TagItem {
  mid: string;
  name: string;
  website: string | null;
  current_category: string | null;
  proposed: string; // CATEGORY_CN 键 或 "Unknown"
}

async function propose() {
  const { default: prisma } = await import("../src/lib/prisma");
  const { CATEGORY_CN } = await import("../src/lib/category-cn");
  const { callAiWithFallback } = await import("../src/lib/ai-service");
  const validCats = Object.keys(CATEGORY_CN);

  const recs = await prisma.merchant_recommendations.findMany({
    where: { source: "node", node_code: NODE_CODE, is_deleted: 0, mid: { not: null } },
    select: { mid: true, merchant_name: true, website: true },
  });
  log(`节点 ${NODE_CODE} 清单商家 ${recs.length} 个`);

  const mids = recs.map((r) => r.mid as string);
  const rows = await prisma.user_merchants.findMany({
    where: { merchant_id: { in: mids }, is_deleted: 0 },
    select: { merchant_id: true, merchant_name: true, merchant_url: true, category: true, category_manual: true },
  });
  // 每个 MID 的现状：有任意一行人工标签（category_manual=1）就跳过；有合法品类值的记下来
  const state = new Map<string, { name: string; url: string | null; cat: string | null; manual: boolean; validCat: string | null }>();
  for (const r of rows) {
    const s = state.get(r.merchant_id) || { name: r.merchant_name, url: r.merchant_url, cat: null, manual: false, validCat: null };
    if (r.category_manual === 1) s.manual = true;
    if (r.category && !s.cat) s.cat = r.category;
    if (r.category && r.category !== "Others" && validCats.includes(r.category)) s.validCat = r.category;
    state.set(r.merchant_id, s);
  }

  const targets: { mid: string; name: string; url: string | null; cat: string | null }[] = [];
  let skipManual = 0, skipValid = 0, notInLib = 0;
  for (const rec of recs) {
    const mid = rec.mid as string;
    const s = state.get(mid);
    if (!s) { notInLib++; continue; } // 未入库的 8 个：库里没行，无处打标，等正式同步后再说
    if (s.manual) { skipManual++; continue; }
    if (s.validCat) { skipValid++; continue; } // 已有合法品类不重打
    targets.push({ mid, name: s.name || rec.merchant_name, url: s.url || rec.website, cat: s.cat });
  }
  log(`待打标 ${targets.length} 个（跳过：人工标签 ${skipManual}、已有合法品类 ${skipValid}、未入库 ${notInLib}）`);

  const items: TagItem[] = [];
  for (let i = 0; i < targets.length; i += BATCH) {
    const chunk = targets.slice(i, i + BATCH);
    const lines = chunk.map((t, j) => `${j + 1}. mid=${t.mid} | name=${t.name} | url=${t.url || "无"}`).join("\n");
    const prompt =
      `你是联盟营销选品助手。根据商家名称和官网域名判断每个商家的主营品类。\n` +
      `品类必须从以下封闭列表中选择（区分大小写，逐字返回）：\n${validCats.join(" | ")}\n` +
      `判断不了的必须返回 "Unknown"，禁止猜测，禁止返回列表之外的值。\n` +
      `商家清单：\n${lines}\n` +
      `只返回 JSON 数组（不要任何其他文字）：[{"mid":"...","category":"..."}]`;
    try {
      const raw = await callAiWithFallback(AI_SCENE, [{ role: "user", content: prompt }], 2000);
      const jsonStr = raw.replace(/```json|```/g, "").trim();
      const parsed = JSON.parse(jsonStr) as { mid: string; category: string }[];
      const byMid = new Map(parsed.map((p) => [String(p.mid), p.category]));
      for (const t of chunk) {
        const cat = byMid.get(t.mid);
        const proposed = cat && validCats.includes(cat) ? cat : "Unknown";
        items.push({ mid: t.mid, name: t.name, website: t.url, current_category: t.cat, proposed });
      }
      log(`批 ${i / BATCH + 1}/${Math.ceil(targets.length / BATCH)} 完成`);
    } catch (e) {
      // 失败路径：该批全部标 Unknown（待人工），不中断后续批次
      log(`批 ${i / BATCH + 1} AI 调用失败（该批全部记 Unknown 待人工）：${e instanceof Error ? e.message : e}`);
      for (const t of chunk) items.push({ mid: t.mid, name: t.name, website: t.url, current_category: t.cat, proposed: "Unknown" });
    }
  }

  const outFile = `/tmp/d278_tag_proposal_${NODE_CODE}.json`;
  writeFileSync(outFile, JSON.stringify({ node: NODE_CODE, generated_at: new Date().toISOString(), items }, null, 2));
  log(`对照表已写 ${outFile}（共 ${items.length} 条，其中 Unknown ${items.filter((x) => x.proposed === "Unknown").length} 条）`);

  const { catCn } = await import("../src/lib/category-cn");
  console.log(`\n| MID | 商家 | 现品类 | AI 建议 |\n|---|---|---|---|`);
  for (const it of items) {
    console.log(`| ${it.mid} | ${it.name} | ${catCn(it.current_category)} | ${it.proposed === "Unknown" ? "❓待人工" : `${catCn(it.proposed)} (${it.proposed})`} |`);
  }
  await prisma.$disconnect();
}

async function apply() {
  if (!FILE) throw new Error("apply 阶段必须 --file= 指定 07 确认过的对照表 JSON");
  const { default: prisma } = await import("../src/lib/prisma");
  const { CATEGORY_CN } = await import("../src/lib/category-cn");
  const validCats = Object.keys(CATEGORY_CN);

  const data = JSON.parse(readFileSync(FILE, "utf-8")) as { items: TagItem[] };
  const todo = data.items.filter((x) => x.proposed !== "Unknown" && validCats.includes(x.proposed));
  log(`确认表共 ${data.items.length} 条，可执行 ${todo.length} 条（Unknown/非法值不动）`);

  // 刷新前备份原值（回滚用）
  const mids = todo.map((t) => t.mid);
  const before = await prisma.user_merchants.findMany({
    where: { merchant_id: { in: mids }, is_deleted: 0, category_manual: 0 },
    select: { id: true, merchant_id: true, category: true },
  });
  const backupFile = `/tmp/d278_tag_backup_${Date.now()}.json`;
  writeFileSync(backupFile, JSON.stringify(before.map((b) => ({ id: String(b.id), merchant_id: b.merchant_id, category: b.category }))));
  log(`已备份 ${before.length} 行原值 → ${backupFile}`);

  let updated = 0;
  for (const t of todo) {
    const r = await prisma.user_merchants.updateMany({
      // 只动非人工行；刷后置 category_manual=1 = 该标签经 07 确认，平台同步不再覆盖
      where: { merchant_id: t.mid, is_deleted: 0, category_manual: 0 },
      data: { category: t.proposed, category_manual: 1 },
    });
    updated += r.count;
  }
  log(`完成：${todo.length} 个商家，共更新 ${updated} 行 user_merchants`);
  await prisma.$disconnect();
}

(PHASE === "apply" ? apply() : propose()).catch((e) => { console.error("失败：", e); process.exit(1); });
