/**
 * D-370：为 bloomroots.top 重写的首页渲染器回归。
 *
 * 该站首页加载的两个脚本都是纯数据，残存部分一处渲染代码都没有 ——
 * 渲染器整段随截断丢了，源码无从找回（无 .bak / 备份目录 / .git / 内联脚本）。
 *
 * 01 原本批准「从 aurislane.top 桥接」，查证后那条路走不通：
 * aurislane 的 script.js 虽然也写 #articlesGrid，但它生成的链接是
 * `article-detail.html?id=...` —— 该页面在 aurislane 上存在（200），
 * 在 bloomroots 上是 404。照抄过去首页会有内容但每篇都点不开。
 * 所以改成按 bloomroots 自己的数据重写，链接读条目的 detailUrl
 * （1037 条全都有，实测 `post-{slug}/` 文章页返回 200）。
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { runInNewContext } from "node:vm";
import { buildBloomrootsRenderer } from "../src/lib/site-templates/bloomroots-renderer";
import { checkJsSyntax, looksLikeRenderer } from "../src/lib/site-write-guard";

/** 线上真实形状（照抄 bloomroots articles-index.js 首条的字段） */
function makeEntries(n: number) {
  return Array.from({ length: n }, (_, i) => ({
    id: String(8000 + i),
    slug: `post-slug-${i}`,
    title: `Title ${i}`,
    category: i % 2 ? "lifestyle" : "home-garden",
    date: `2026-10-${String(28 - i).padStart(2, "0")}`,
    dateISO: `2026-10-${String(28 - i).padStart(2, "0")}`,
    dateLabel: `Oct ${28 - i}, 2026`,
    readTime: "4 min read",
    excerpt: `Excerpt ${i}`,
    image: i === 3 ? "" : `/images/articles/${8000 + i}_0.webp`,
    heroImage: i === 3 ? "" : `/images/articles/${8000 + i}_0.webp`,
    detailUrl: `post-i-turned-my-family-photos-${i}`,
    tags: ["lifestyle"],
  }));
}

function makeDom() {
  const mk = (id: string) => {
    const el: Record<string, unknown> = {
      id, innerHTML: "", textContent: "", disabled: false,
      listeners: {} as Record<string, Array<() => void>>,
    };
    el.addEventListener = (ev: string, fn: () => void) => {
      const ls = el.listeners as Record<string, Array<() => void>>;
      (ls[ev] = ls[ev] || []).push(fn);
    };
    el.querySelectorAll = () => [];
    return el;
  };
  const store: Record<string, Record<string, unknown>> = {
    articlesGrid: mk("articlesGrid"),
    pagination: mk("pagination"),
    categoryTitle: mk("categoryTitle"),
    categorySubtitle: mk("categorySubtitle"),
  };
  const document = {
    readyState: "complete",
    getElementById: (id: string) => store[id] || null,
    addEventListener: () => undefined,
    createElement: () => mk("created"),
  };
  return { document, store };
}

/** 把「数据文件 + 渲染器」一起跑起来，模拟浏览器加载两个 script 的效果 */
function run(entries: unknown[], varName = "articlesIndex", search = "") {
  const { document, store } = makeDom();
  const data = `var ${varName} = ${JSON.stringify(entries)};`;
  const sandbox = {
    document,
    window: { scrollTo: () => undefined, location: { search } },
    console,
  };
  runInNewContext(data + "\n" + buildBloomrootsRenderer(), sandbox);
  return store;
}

describe("D-370 bloomroots.top 重写的渲染器", () => {
  const js = buildBloomrootsRenderer();

  it("语法合法且被判定为渲染器", () => {
    assert.equal(checkJsSyntax(js).ok, true);
    assert.equal(looksLikeRenderer(js), true);
  });

  it("独立成文件：不含数据声明（D-370 的教训）", () => {
    assert.ok(!/(?:const|var|let)\s+articlesIndex\s*=\s*\[/.test(js),
      "渲染器里不该带数据 —— 同住一个文件时任何一次写入没写完丢的都是渲染器");
  });

  it("把卡片写进 #articlesGrid，每页 6 条", () => {
    const store = run(makeEntries(14));
    const html = String(store.articlesGrid.innerHTML);
    assert.equal((html.match(/class="article-card"/g) || []).length, 6);
  });

  it("链接用条目自己的 detailUrl —— 不是 aurislane 那套 article-detail.html", () => {
    const store = run(makeEntries(3));
    const html = String(store.articlesGrid.innerHTML);
    assert.ok(html.includes('href="/post-i-turned-my-family-photos-0/"'), "应按 detailUrl 生成");
    assert.ok(!html.includes("article-detail.html"), "绝不能生成 bloomroots 上 404 的那种链接");
  });

  it("卡片里没有 undefined", () => {
    const store = run(makeEntries(6));
    assert.ok(!String(store.articlesGrid.innerHTML).includes("undefined"));
  });

  it("两种数据变量名都认（articlesIndex / articlesData）", () => {
    for (const v of ["articlesIndex", "articlesData"]) {
      const store = run(makeEntries(3), v);
      assert.ok(String(store.articlesGrid.innerHTML).includes("article-card"), `${v} 应被认出`);
    }
  });

  it("分页按条数生成，首页 Prev 禁用", () => {
    const store = run(makeEntries(14));
    const pg = String(store.pagination.innerHTML);
    assert.ok(pg.includes("disabled"), "第 1 页 Prev 应禁用");
    assert.equal((pg.match(/data-p=/g) || []).length, 3 + 2, "14 条 / 6 = 3 页，另加 Prev/Next");
  });

  it("条目少于一页时不画分页", () => {
    const store = run(makeEntries(4));
    assert.equal(String(store.pagination.innerHTML), "");
  });

  it("缺图走占位，不生成空 src", () => {
    const store = run(makeEntries(6));
    const html = String(store.articlesGrid.innerHTML);
    assert.ok(!html.includes('src=""'));
    assert.ok(html.includes("article-card-ph"), "第 4 条缺图，应走占位");
  });

  it("空数据时显示提示而不是白屏", () => {
    const store = run([]);
    assert.ok(String(store.articlesGrid.innerHTML).includes("No articles yet"));
  });

  it("标题被转义", () => {
    const e = makeEntries(1);
    (e[0] as Record<string, unknown>).title = '<img src=x onerror=alert(1)>';
    const store = run(e);
    const html = String(store.articlesGrid.innerHTML);
    assert.ok(!html.includes("<img src=x"));
    assert.ok(html.includes("&lt;img"));
  });

  it("按日期倒序（新的在前）", () => {
    const store = run(makeEntries(6));
    const html = String(store.articlesGrid.innerHTML);
    assert.ok(html.indexOf("Title 0") < html.indexOf("Title 1"), "Oct 28 应排在 Oct 27 前面");
  });

  it("category.html?cat=xxx 只展示该分类，不是全部混在一起", () => {
    const store = run(makeEntries(14), "articlesIndex", "?cat=lifestyle");
    const html = String(store.articlesGrid.innerHTML);
    assert.ok(html.includes("Title 1"), "奇数下标是 lifestyle，应出现");
    assert.ok(!html.includes("Title 0"), "偶数下标是 home-garden，不该出现");
  });

  it("分类页填 categoryTitle/categorySubtitle，不留模板占位字", () => {
    const store = run(makeEntries(6), "articlesIndex", "?cat=lifestyle");
    assert.ok(String(store.categoryTitle.innerHTML).toLowerCase().includes("lifestyle"));
    assert.ok(String(store.categorySubtitle.innerHTML).toLowerCase().includes("lifestyle"));
  });

  it("分类下没有文章时提示而不是空白网格", () => {
    const store = run(makeEntries(6), "articlesIndex", "?cat=finance");
    assert.ok(String(store.articlesGrid.innerHTML).includes("No articles yet"));
    assert.ok(String(store.categorySubtitle.innerHTML).includes("No articles"));
  });

  it("没有 cat 参数（首页）时不过滤，照常展示全部分类", () => {
    const store = run(makeEntries(6));
    const html = String(store.articlesGrid.innerHTML);
    assert.ok(html.includes("Title 0") && html.includes("Title 1"), "首页两种分类都该出现");
  });
});
