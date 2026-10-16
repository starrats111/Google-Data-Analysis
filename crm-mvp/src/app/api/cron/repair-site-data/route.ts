/**
 * GET /api/cron/repair-site-data — D-370 修复「首页白屏」的站点数据文件
 *
 * 为什么要这个路由：修复本身是 CRM 自己 SSH 到站群机完成的，
 * 所以只要能在 CRM 上触发就够，不需要操作者有站群机的 SSH 权限。
 * `scripts/d368-repair-broken-site-js.ts` 需要在生产机上跑；这个路由是它的 HTTP 等价物。
 *
 * **不要用 `/api/cron/standardize-all-sites` 来修这类故障。** 那条路走
 * `applyA1SiteStandard`，它从**现有文件**读 posts 再写回；而这里要修的恰恰是
 * 解析不出来的损坏文件，解析失败会落到空列表、把该站文章列表清成 0。
 * （D-370 已给它加了拒绝执行的护栏，但它依然不是修复工具。）
 * 本路由走 `repairSiteDataFile`，按**库里的 articles** 重建 —— 库才是真值。
 *
 * 参数：
 *   ?mode=scan          只报告，不碰服务器（默认）
 *   ?mode=dry           算出将写入多少条，仍不落盘
 *   ?mode=apply         实修（原文件先备份成 *.d368-broken-<时间>.bak）
 *   ?only=<域名包含串>   仅处理匹配的站
 *   ?limit=N            本轮最多处理 N 个（低配机建议分批）
 *   ?allow_shrink=1     放行「库里比站上少太多」的站 —— 见下方警告
 *
 * ⚠ allow_shrink 的含义：库里文章数少于线上估算的 60% 时，重建会把站上多出来的
 *   条目从索引里抹掉 —— 文章详情页还在，但首页和列表再也找不到它们，等于静默
 *   下线几百篇。默认拒绝执行并报 skipped_would_shrink。只有在人工核对过差额
 *   那批条目确实该下线之后，才加这个参数。
 *
 * 鉴权：CRON_SECRET（Authorization: Bearer ...）
 * 低配机注意：串行执行，单站之间不并发；并发由 withSiteLock 另行兜底。
 */
import { NextRequest, NextResponse } from "next/server";
import prisma from "@/lib/prisma";
import { repairSiteDataFile, type RepairSiteResult } from "@/lib/remote-publisher";
import { checkJsSyntax, isDataOnly, looksLikeRenderer } from "@/lib/site-write-guard";

export const dynamic = "force-dynamic";
export const maxDuration = 800;

const TIMEOUT_MS = 25_000;

let isRunning = false;

function verifyCron(req: NextRequest): boolean {
  const secret = process.env.CRON_SECRET;
  if (!secret) return false;
  return req.headers.get("authorization") === `Bearer ${secret}`;
}

function log(msg: string) {
  console.error(`[CRON repair-site-data ${new Date().toISOString()}] ${msg}`);
}

interface ScanVerdict {
  home: number;
  verdict: "ok" | "truncated" | "no_renderer" | "home_bad" | "no_script" | "unreachable";
  detail?: string;
  live_entries: number;
}

/**
 * 公网侧判定：跟首页**实际引用**的脚本走，扫完全部脚本再判。
 *
 * 两条判据缺一不可：
 *   - 截断：任一本站脚本语法编译不过
 *   - 渲染器被抹：全部脚本扫完，有数据却没有任何 DOM 写入代码。
 *     这一类语法完全合法，只看语法会漏（parcelnplate.top / aura-bloom.top 形态）。
 *
 * 必须扫全部脚本、且判据不能绑定 A1 的标识：站群里模板不止一套
 * （kivanta.top 容器叫 articlesGrid、渲染器写 products-container），
 * 只看第一个脚本或只认 A1 特征串都会误判 —— 这两个坑都实际踩过。
 */
async function scanSite(domain: string): Promise<ScanVerdict> {
  let html = "";
  let home = 0;
  try {
    const res = await fetch(`https://${domain}/`, {
      redirect: "follow",
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    home = res.status;
    if (!res.ok) return { home, verdict: "home_bad", live_entries: 0 };
    html = await res.text();
  } catch (e) {
    return {
      home: 0,
      verdict: "unreachable",
      detail: e instanceof Error ? e.message.slice(0, 120) : String(e),
      live_entries: 0,
    };
  }

  const srcs: string[] = [];
  const re = /<script[^>]+src=["']([^"']+)["']/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null) {
    const raw = m[1];
    if (/^https?:\/\//i.test(raw) || raw.startsWith("//")) continue;
    srcs.push(raw.replace(/^\.?\//, ""));
  }
  if (srcs.length === 0) return { home, verdict: "no_script", live_entries: 0 };

  let scanned = 0;
  let anyDataOnly = false;
  let anyRenderer = false;
  let entries = 0;

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

    const syntax = checkJsSyntax(js);
    const cnt = (js.match(/"id"\s*:/g) || []).length || (js.match(/\bid\s*:/g) || []).length;
    entries += cnt;

    if (!syntax.ok) {
      return {
        home,
        verdict: "truncated",
        detail: `${src} ${js.length}B${syntax.line ? ` 第 ${syntax.line} 行` : ""}：${syntax.error}`,
        live_entries: entries,
      };
    }
    scanned++;
    anyDataOnly = anyDataOnly || isDataOnly(js);
    anyRenderer = anyRenderer || looksLikeRenderer(js);
  }

  if (scanned > 0 && anyDataOnly && !anyRenderer) {
    return {
      home,
      verdict: "no_renderer",
      detail: `${scanned} 个脚本有数据、无任何渲染代码 —— 列表容器没人填，语法合法但页面白屏`,
      live_entries: entries,
    };
  }
  return { home, verdict: "ok", live_entries: entries };
}

/**
 * 从公网取该站首页加载的脚本，解析出条目（id / slug / 日期）。
 *
 * 截断的文件也要能解析出前半截 —— 差额比对正是在这种文件上做的，
 * 所以不能靠 JSON.parse 整体解析，改成逐条正则抽取。
 */
async function fetchLiveEntries(
  domain: string,
): Promise<Array<{ id: string; slug: string; date: string }>> {
  let html = "";
  try {
    const r = await fetch(`https://${domain}/`, {
      redirect: "follow",
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!r.ok) return [];
    html = await r.text();
  } catch {
    return [];
  }

  const srcs: string[] = [];
  const re = /<script[^>]+src=["']([^"']+)["']/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null) {
    const raw = m[1];
    if (/^https?:\/\//i.test(raw) || raw.startsWith("//")) continue;
    srcs.push(raw.replace(/^\.?\//, "").split("?")[0]);
  }

  const entries: Array<{ id: string; slug: string; date: string }> = [];
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
    // 逐条抽取：每个 {...} 片段里取 id / slug / dateISO|date
    const objRe = /\{[^{}]*?"id"\s*:\s*"?([^",}]+)"?[^{}]*?\}/g;
    let om: RegExpExecArray | null;
    while ((om = objRe.exec(js)) !== null) {
      const chunk = om[0];
      const slug = /"slug"\s*:\s*"([^"]*)"/.exec(chunk)?.[1] || "";
      const date = /"dateISO"\s*:\s*"([^"]*)"/.exec(chunk)?.[1]
        || /"date"\s*:\s*"(\d{4}-\d{2}-\d{2})"/.exec(chunk)?.[1]
        || "";
      entries.push({ id: String(om[1]).trim(), slug, date });
    }
  }
  // 同一条可能在多个脚本里都有，按 id 去重
  const seen = new Set<string>();
  return entries.filter((e) => (seen.has(e.id) ? false : (seen.add(e.id), true)));
}

export async function GET(req: NextRequest) {
  if (!verifyCron(req)) {
    return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
  }
  if (isRunning) {
    return NextResponse.json({ ok: false, error: "another run is in progress" }, { status: 409 });
  }
  isRunning = true;
  const startedAt = Date.now();

  try {
    const url = new URL(req.url);
    const mode = (url.searchParams.get("mode") || "scan").toLowerCase();
    const only = (url.searchParams.get("only") || "").trim().toLowerCase();
    const limit = Math.max(0, parseInt(url.searchParams.get("limit") || "0", 10) || 0);
    const allowShrink = url.searchParams.get("allow_shrink") === "1";

    if (!["scan", "dry", "apply", "diff"].includes(mode)) {
      return NextResponse.json({ ok: false, error: "mode 只能是 scan / dry / apply / diff" }, { status: 400 });
    }

    // D-370 mode=diff：只读。把线上文件里的条目和库里的已发布文章逐条比，
    // 列出「线上有、库里没有」的那批（= 按库重建会丢掉的），并按发布月份汇总。
    // 这是回答「差额里有没有近一个月的文章」唯一可靠的办法 ——
    // 看线上条目的月份分布不行，那是全部条目，不是差额那批。
    if (mode === "diff") {
      const out: unknown[] = [];
      let sites2 = await prisma.publish_sites.findMany({
        where: { is_deleted: 0, status: "active" },
        select: { id: true, domain: true, site_path: true, data_js_path: true },
        orderBy: { id: "asc" },
      });
      if (only) sites2 = sites2.filter((s) => s.domain.toLowerCase().includes(only));

      for (const s of sites2) {
        const live = await fetchLiveEntries(s.domain);
        if (live.length === 0) {
          out.push({ domain: s.domain, error: "线上取不到条目" });
          continue;
        }
        const dbRows = await prisma.articles.findMany({
          where: { publish_site_id: s.id, is_deleted: 0, status: "published" },
          select: { id: true, slug: true, published_at: true },
        });
        const dbIds = new Set(dbRows.map((r) => String(r.id)));
        const dbSlugs = new Set(dbRows.map((r) => (r.slug || "").toLowerCase()).filter(Boolean));

        const surplus = live.filter((e) =>
          !dbIds.has(String(e.id)) && !dbSlugs.has((e.slug || "").toLowerCase()));

        const byMonth: Record<string, number> = {};
        for (const e of surplus) {
          const mm = (e.date || "").slice(0, 7) || "未知";
          byMonth[mm] = (byMonth[mm] || 0) + 1;
        }
        const cutoff = new Date(Date.now() - 30 * 86400_000).toISOString().slice(0, 10);
        const recent = surplus.filter((e) => (e.date || "") >= cutoff);

        out.push({
          domain: s.domain,
          live_entries: live.length,
          db_articles: dbRows.length,
          surplus_count: surplus.length,
          surplus_by_month: byMonth,
          surplus_recent_30d: recent.length,
          recent_samples: recent.slice(0, 10).map((e) => ({ id: e.id, slug: e.slug, date: e.date })),
        });
      }
      return NextResponse.json({ ok: true, mode, elapsed_ms: Date.now() - startedAt, results: out });
    }

    let sites = await prisma.publish_sites.findMany({
      where: { is_deleted: 0, status: "active" },
      select: {
        id: true, domain: true, site_path: true, site_type: true,
        data_js_path: true, article_var_name: true, article_html_pattern: true,
      },
      orderBy: { id: "asc" },
    });
    if (only) sites = sites.filter((s) => s.domain.toLowerCase().includes(only));

    log(`mode=${mode} 待检 ${sites.length} 个站${allowShrink ? "（allow_shrink 已开）" : ""}`);

    const scanned: Array<{ domain: string } & ScanVerdict & { db_articles?: number }> = [];
    const repaired: RepairSiteResult[] = [];

    for (const site of sites) {
      const v = await scanSite(site.domain);
      const broken = v.verdict === "truncated" || v.verdict === "no_renderer";

      const dbCount = await prisma.articles.count({
        where: { publish_site_id: site.id, is_deleted: 0, status: "published" },
      });
      scanned.push({ domain: site.domain, ...v, db_articles: dbCount });
      log(`${site.domain}: ${v.verdict} 线上条目=${v.live_entries} 库内=${dbCount}${v.detail ? " — " + v.detail : ""}`);

      if (!broken || mode === "scan") continue;
      if (limit > 0 && repaired.length >= limit) continue;
      // site_path 在库里可空；没有远程路径的站根本无从修复，跳过而不是硬转类型
      if (!site.site_path) {
        log(`${site.domain}: 跳过 —— publish_sites.site_path 为空，无法定位远程目录`);
        repaired.push({
          domain: site.domain,
          before: { bytes: 0, syntax_ok: false, parsed_entries: null },
          db_articles: dbCount,
          action: "failed",
          error: "publish_sites.site_path 为空，无法定位远程目录",
        });
        continue;
      }

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
        { dryRun: mode === "dry", allowShrink },
      );
      repaired.push(res);
      log(`${site.domain}: ${res.action} 写入=${res.written_entries ?? "-"}${res.error ? " — " + res.error : ""}`);
    }

    const brokenList = scanned.filter((s) => s.verdict === "truncated" || s.verdict === "no_renderer");
    return NextResponse.json({
      ok: true,
      mode,
      elapsed_ms: Date.now() - startedAt,
      checked: scanned.length,
      broken: brokenList.length,
      broken_sites: brokenList.map((b) => ({
        domain: b.domain,
        verdict: b.verdict,
        live_entries: b.live_entries,
        db_articles: b.db_articles,
        detail: b.detail,
      })),
      repaired: repaired.map((r) => ({
        domain: r.domain,
        action: r.action,
        // D-370：实际处理的文件，可能不等于库里登记的 data_js_path
        repaired_path: r.repaired_path,
        before_bytes: r.before.bytes,
        before_syntax_ok: r.before.syntax_ok,
        db_articles: r.db_articles,
        written_entries: r.written_entries,
        error: r.error,
      })),
      results: scanned,
    });
  } catch (err) {
    log(`异常：${err instanceof Error ? err.message : String(err)}`);
    return NextResponse.json(
      { ok: false, error: err instanceof Error ? err.message : String(err) },
      { status: 500 },
    );
  } finally {
    isRunning = false;
  }
}
