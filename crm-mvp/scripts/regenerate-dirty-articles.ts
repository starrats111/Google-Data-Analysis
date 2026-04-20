/**
 * 批量重生成含 reasoning 残留（<think>/<thinking>/<scratchpad>）的脏文章 — HTTP 客户端版
 *
 * 设计：脚本通过 HTTP 调用 PM2 进程内的 admin API，绕过 tsx 独立进程下
 * @prisma/adapter-mariadb 的 pool timeout 故障。鉴权复用 CRON_SECRET。
 *
 * 使用：
 *   CRON_SECRET=xxx npx tsx scripts/regenerate-dirty-articles.ts --dry-run --include-deleted
 *   CRON_SECRET=xxx npx tsx scripts/regenerate-dirty-articles.ts --only-id=1203
 *   CRON_SECRET=xxx npx tsx scripts/regenerate-dirty-articles.ts --include-deleted
 *
 * 也可以从 .env 自动读取 CRON_SECRET，无需手动注入。
 */

import fs from "fs";
import path from "path";

const IS_DRY_RUN = process.argv.includes("--dry-run");
const INCLUDE_DELETED = process.argv.includes("--include-deleted");
const KEEP_GOING = process.argv.includes("--keep-going");
const ONLY_ID = (() => {
  const arg = process.argv.find((a) => a.startsWith("--only-id="));
  return arg ? arg.split("=")[1] : null;
})();
const BASE_URL = (() => {
  const arg = process.argv.find((a) => a.startsWith("--base="));
  return arg ? arg.split("=")[1] : "http://127.0.0.1:20050";
})();
const SLEEP_BETWEEN_MS = 5000;

function loadCronSecret(): string {
  if (process.env.CRON_SECRET) return process.env.CRON_SECRET;
  try {
    const envPath = path.resolve(process.cwd(), ".env");
    const text = fs.readFileSync(envPath, "utf8");
    for (const line of text.split("\n")) {
      const m = line.match(/^CRON_SECRET=(.*)$/);
      if (m) return m[1].replace(/^"|"$/g, "").trim();
    }
  } catch { /* ignore */ }
  return "";
}

const CRON_SECRET = loadCronSecret();
if (!CRON_SECRET) {
  console.error("缺少 CRON_SECRET（环境变量或 .env 都没有）");
  process.exit(1);
}

const HEADERS = {
  Authorization: `Bearer ${CRON_SECRET}`,
  "Content-Type": "application/json",
};

function log(msg: string) { console.log(`[${new Date().toISOString()}] ${msg}`); }
function ok(msg: string)  { console.log(`[${new Date().toISOString()}] ✓ ${msg}`); }
function warn(msg: string){ console.warn(`[${new Date().toISOString()}] ⚠ ${msg}`); }
function fail(msg: string){ console.error(`[${new Date().toISOString()}] ✗ ${msg}`); }
function sleep(ms: number) { return new Promise((r) => setTimeout(r, ms)); }

interface DirtyItem {
  id: string;
  title: string;
  slug: string;
  status: string;
  is_deleted: number;
  publish_site_id: string | null;
  created_at: string;
}

async function fetchDirtyList(): Promise<DirtyItem[]> {
  const url = `${BASE_URL}/api/admin/regenerate-clean-article?includeDeleted=${INCLUDE_DELETED ? 1 : 0}`;
  const res = await fetch(url, { headers: HEADERS });
  if (!res.ok) {
    throw new Error(`GET ${url} → ${res.status} ${await res.text().catch(() => "")}`);
  }
  const json: any = await res.json();
  if (!json.ok) throw new Error(`GET dirty list 失败: ${JSON.stringify(json)}`);
  return json.dirty as DirtyItem[];
}

async function regenerateOne(id: string): Promise<{ ok: boolean; data: any }> {
  const url = `${BASE_URL}/api/admin/regenerate-clean-article`;
  const res = await fetch(url, { method: "POST", headers: HEADERS, body: JSON.stringify({ id }) });
  let json: any = null;
  try { json = await res.json(); } catch { /* ignore */ }
  return { ok: res.ok && json?.ok === true, data: json ?? { http_status: res.status } };
}

async function main() {
  log(`模式: ${IS_DRY_RUN ? "DRY-RUN" : "REAL-RUN"} | base=${BASE_URL}`);
  log(`include-deleted: ${INCLUDE_DELETED} | only-id: ${ONLY_ID ?? "(all dirty)"} | keep-going: ${KEEP_GOING}`);

  let targets: DirtyItem[];
  if (ONLY_ID) {
    targets = [{ id: ONLY_ID, title: "(指定 id)", slug: "", status: "?", is_deleted: 0, publish_site_id: null, created_at: "" }];
    log(`仅处理 #${ONLY_ID}`);
  } else {
    log("从 PM2 获取 dirty 文章清单 ...");
    targets = await fetchDirtyList();
    log(`命中 ${targets.length} 篇 dirty 文章`);
    for (const a of targets) {
      log(`  #${a.id} status=${a.status} is_deleted=${a.is_deleted} site=${a.publish_site_id ?? "-"} slug=${a.slug} title="${(a.title || "").slice(0, 60)}"`);
    }
  }

  if (targets.length === 0) {
    ok("无需处理，退出");
    return;
  }

  if (IS_DRY_RUN) {
    ok("DRY-RUN 结束，未改动任何数据");
    return;
  }

  let okCount = 0;
  let failCount = 0;

  for (let i = 0; i < targets.length; i++) {
    const t = targets[i];
    const tag = `[${i + 1}/${targets.length}] #${t.id}`;
    log(`${tag} ▶ POST regenerate ...`);

    const t0 = Date.now();
    let r: { ok: boolean; data: any };
    try {
      r = await regenerateOne(t.id);
    } catch (e) {
      r = { ok: false, data: { error: e instanceof Error ? e.message : String(e) } };
    }
    const dur = Date.now() - t0;

    if (r.ok) {
      okCount++;
      const d = r.data;
      ok(`${tag} 完成 (耗时 ${dur}ms, content=${d.contentLen}字, repushed=${d.repushed}, restoredFromDeleted=${d.restoredFromDeleted}${d.publishedUrl ? `, url=${d.publishedUrl}` : ""}${d.warning ? `, warn=${d.warning}` : ""})`);
    } else {
      failCount++;
      fail(`${tag} 失败 (耗时 ${dur}ms): ${JSON.stringify(r.data)}`);
      if (!KEEP_GOING) {
        fail(`未加 --keep-going，立即终止（成功 ${okCount} / 失败 ${failCount} / 剩余 ${targets.length - i - 1}）`);
        process.exit(1);
      }
    }

    if (i < targets.length - 1) {
      log(`   sleep ${SLEEP_BETWEEN_MS}ms ...`);
      await sleep(SLEEP_BETWEEN_MS);
    }
  }

  log(`=== 汇总: 成功 ${okCount} / 失败 ${failCount} / 共 ${targets.length} ===`);
}

main().catch((e) => {
  fail(`致命错误: ${e instanceof Error ? e.stack : e}`);
  process.exit(1);
});
