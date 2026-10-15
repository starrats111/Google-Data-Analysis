/**
 * D-368 修复脚本：全站群扫描「首页脚本语法损坏」并按库里 articles 重建
 *
 * 背景见 src/lib/site-write-guard.ts 顶部注释。一句话：站点数据文件
 * （assets/js/main.js 等）被并发读改写弄成语法损坏，脚本整体不执行，
 * 该站首页就是一片空白 —— 而首页和文章页 HTTP 全程 200，旧巡检看不见。
 *
 * 用法（在生产机 crm-mvp 目录下）：
 *   # 1) 只扫描，不改任何东西 —— 先看清范围
 *   npx tsx scripts/d368-repair-broken-site-js.ts --scan
 *
 *   # 2) 空跑：对损坏的站算出将写入多少条，仍不落盘
 *   npx tsx scripts/d368-repair-broken-site-js.ts --dry-run
 *
 *   # 3) 实修（会先把损坏文件备份成 *.d368-broken-<时间>.bak）
 *   npx tsx scripts/d368-repair-broken-site-js.ts --apply
 *
 *   # 只处理指定站点
 *   npx tsx scripts/d368-repair-broken-site-js.ts --apply --only omniportal.shop
 *
 * 安全：--apply 之外的模式一律不写服务器。实修对每个站的保护见
 * repairSiteDataFile()：文件完好则跳过、库里 0 篇则拒绝、写入走护栏、持站点锁。
 */
import prisma from "../src/lib/prisma";
import { checkJsSyntax } from "../src/lib/site-write-guard";
import { repairSiteDataFile } from "../src/lib/remote-publisher";

const TIMEOUT_MS = 25_000;

interface ScanRow {
  domain: string;
  siteId: bigint;
  sitePath: string;
  dataJsPath: string | null;
  varName: string | null;
  home: number;
  script: string | null;
  bytes: number;
  syntaxOk: boolean;
  detail?: string;
  dbArticles: number;
}

/** 取首页引用的本站脚本，逐个做语法编译 */
async function scanSite(domain: string): Promise<{
  home: number;
  script: string | null;
  bytes: number;
  syntaxOk: boolean;
  detail?: string;
}> {
  let home = 0;
  try {
    const res = await fetch(`https://${domain}/`, {
      redirect: "follow",
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    home = res.status;
    if (!res.ok) return { home, script: null, bytes: 0, syntaxOk: true, detail: "首页非 200，跳过脚本检查" };
    const html = await res.text();

    const srcs: string[] = [];
    const re = /<script[^>]+src=["']([^"']+)["']/gi;
    let m: RegExpExecArray | null;
    while ((m = re.exec(html)) !== null) {
      const raw = m[1];
      if (/^https?:\/\//i.test(raw) || raw.startsWith("//")) continue;
      srcs.push(raw.replace(/^\.?\//, ""));
    }
    if (srcs.length === 0) {
      return { home, script: null, bytes: 0, syntaxOk: true, detail: "首页没有本站脚本引用" };
    }

    let checkedBytes = 0;
    let lastChecked: string | null = null;

    for (const src of srcs) {
      let js = "";
      try {
        const r = await fetch(`https://${domain}/${src}`, {
          redirect: "follow",
          signal: AbortSignal.timeout(TIMEOUT_MS),
        });
        if (!r.ok) continue;
        js = await r.text();
      } catch {
        continue;
      }
      if (js.trim().length === 0) continue;

      checkedBytes += js.length;
      lastChecked = src;

      const syntax = checkJsSyntax(js);
      if (!syntax.ok) {
        return {
          home,
          script: src,
          bytes: js.length,
          syntaxOk: false,
          detail: `${syntax.line ? `第 ${syntax.line} 行：` : ""}${syntax.error}`,
        };
      }
    }
    return {
      home,
      script: lastChecked,
      bytes: checkedBytes,
      syntaxOk: true,
      detail: lastChecked ? undefined : "首页脚本都取不到或为空",
    };
  } catch (e) {
    return {
      home,
      script: null,
      bytes: 0,
      syntaxOk: true,
      detail: `探测失败：${e instanceof Error ? e.message.slice(0, 120) : String(e)}`,
    };
  }
}

async function main() {
  const args = process.argv.slice(2);
  const mode = args.includes("--apply") ? "apply" : args.includes("--dry-run") ? "dry-run" : "scan";
  const onlyIdx = args.indexOf("--only");
  const only = onlyIdx >= 0 ? (args[onlyIdx + 1] || "").toLowerCase() : "";
  const force = args.includes("--force");

  let sites = await prisma.publish_sites.findMany({
    where: { is_deleted: 0, status: "active" },
    select: {
      id: true, domain: true, site_path: true, site_type: true,
      data_js_path: true, article_var_name: true, article_html_pattern: true,
    },
    orderBy: { id: "asc" },
  });
  if (only) sites = sites.filter((s) => s.domain.toLowerCase().includes(only));

  console.log(`模式=${mode}${force ? " (force)" : ""}  待检站点=${sites.length}\n`);

  const rows: ScanRow[] = [];
  for (const s of sites) {
    const scan = await scanSite(s.domain);
    const dbArticles = await prisma.articles.count({
      where: { publish_site_id: s.id, is_deleted: 0, status: "published" },
    });
    rows.push({
      domain: s.domain,
      siteId: s.id,
      sitePath: s.site_path,
      dataJsPath: s.data_js_path,
      varName: s.article_var_name,
      dbArticles,
      ...scan,
    });
    const flag = scan.syntaxOk ? "OK    " : "BROKEN";
    console.log(
      `${flag} ${s.domain.padEnd(28)} home=${scan.home} ` +
      `${scan.script ? scan.script : "-"} ${scan.bytes ? scan.bytes + "B " : ""}` +
      `库内已发布=${dbArticles}${scan.detail && !scan.syntaxOk ? ` — ${scan.detail}` : ""}`,
    );
  }

  const broken = rows.filter((r) => !r.syntaxOk);
  console.log(`\n===== 扫描结论：${rows.length} 个站，${broken.length} 个脚本语法损坏 =====`);
  for (const b of broken) {
    console.log(`  ${b.domain}  ${b.script} ${b.bytes}B  库内已发布 ${b.dbArticles} 篇  — ${b.detail}`);
  }

  if (mode === "scan") {
    console.log("\n（--scan 只报告。接着跑 --dry-run 看将写入多少条，再 --apply 实修）");
    await prisma.$disconnect();
    return;
  }

  const targets = force ? rows : broken;
  if (targets.length === 0) {
    console.log("\n没有需要处理的站点。");
    await prisma.$disconnect();
    return;
  }

  console.log(`\n===== ${mode === "apply" ? "开始修复" : "空跑"}：${targets.length} 个站 =====`);
  for (const t of targets) {
    const site = sites.find((s) => s.domain === t.domain)!;
    const articles = await prisma.articles.findMany({
      where: { publish_site_id: site.id, is_deleted: 0, status: "published" },
      select: {
        id: true, title: true, slug: true, content: true, excerpt: true,
        category: true, images: true, published_at: true, published_url: true, created_at: true,
      },
      orderBy: { published_at: "desc" },
    });

    const res = await repairSiteDataFile(
      {
        domain: site.domain,
        site_path: site.site_path,
        site_type: site.site_type,
        data_js_path: site.data_js_path,
        article_var_name: site.article_var_name,
        article_html_pattern: site.article_html_pattern,
      },
      articles.map((a) => ({ ...a, id: String(a.id) })),
      { dryRun: mode === "dry-run", force },
    );

    console.log(
      `  ${res.domain.padEnd(28)} ${res.action.padEnd(20)} ` +
      `修前 ${res.before.bytes}B syntax=${res.before.syntax_ok ? "ok" : "BROKEN"} ` +
      `解析出=${res.before.parsed_entries ?? "null"}  库内=${res.db_articles}  ` +
      `写入=${res.written_entries ?? "-"}${res.error ? `  — ${res.error}` : ""}`,
    );
  }

  console.log("\n完成。实修后请重跑 --scan 确认全部 OK，并清一次 Cloudflare 缓存。");
  await prisma.$disconnect();
}

main().catch(async (e) => {
  console.error("脚本异常：", e);
  await prisma.$disconnect();
  process.exit(1);
});
