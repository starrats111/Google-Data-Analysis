/**
 * D-370：thegoodsandguard.top / everydaynes.top 专属渲染器回归。
 *
 * 同一类坑第二、第三次踩（第一次 aura-bloom.top）：容器名改对之后 apply
 * 实测又因 A1 模板的其它硬编码容器 TypeError 中断，两站首页布局各自
 * 独立、互不相同，各写专属渲染器。
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { runInNewContext } from "node:vm";
import { buildTheGoodsAndGuardRenderer } from "../src/lib/site-templates/thegoodsandguard-renderer";
import { buildEverydaynesRenderer } from "../src/lib/site-templates/everydaynes-renderer";
import { checkJsSyntax, looksLikeRenderer } from "../src/lib/site-write-guard";

function makeEntries(n: number, categories: string[]) {
  return Array.from({ length: n }, (_, i) => ({
    id: String(8000 + i),
    slug: `post-slug-${i}`,
    title: `Title ${i}`,
    category: categories[i % categories.length],
    date: `2026-10-${String(28 - i).padStart(2, "0")}`,
    dateISO: `2026-10-${String(28 - i).padStart(2, "0")}`,
    dateLabel: `Oct ${28 - i}, 2026`,
    readTime: "4 min read",
    excerpt: `Excerpt ${i}`,
    image: i === 3 ? "" : `/images/articles/${8000 + i}_0.webp`,
    heroImage: i === 3 ? "" : `/images/articles/${8000 + i}_0.webp`,
    detailUrl: `post-title-${i}`,
    tags: [categories[i % categories.length]],
  }));
}

function makeChip(category: string, active = false) {
  const classes = new Set<string>(active ? ["active"] : []);
  const listeners: Array<() => void> = [];
  return {
    getAttribute: (name: string) => (name === "data-category" ? category : null),
    classList: {
      add: (c: string) => classes.add(c),
      remove: (c: string) => classes.delete(c),
      has: (c: string) => classes.has(c),
    },
    addEventListener: (ev: string, fn: () => void) => { if (ev === "click") listeners.push(fn); },
    click() { const self = this; listeners.forEach((fn) => fn.call(self)); },
  };
}

function makeDom(opts: { chips?: string[]; categoryTagsIsEmpty?: boolean }) {
  const mk = (id: string) => {
    const el: Record<string, unknown> = { id, innerHTML: "" };
    el.addEventListener = () => undefined;
    el.querySelectorAll = () => [];
    return el;
  };
  const chips = (opts.chips || []).map((c, i) => makeChip(c, i === 0));
  const store: Record<string, Record<string, unknown>> = {
    articleGrid: mk("articleGrid"),
    pagination: mk("pagination"),
    paginationControls: mk("paginationControls"),
    searchInput: mk("searchInput"),
  };
  if (opts.categoryTagsIsEmpty) store.categoryTags = mk("categoryTags");
  const document = {
    readyState: "complete",
    getElementById: (id: string) => store[id] || null,
    querySelectorAll: (sel: string) => (sel === "[data-category]" ? chips : []),
    addEventListener: () => undefined,
  };
  return { document, store, chips };
}

describe("D-370 thegoodsandguard.top 专属渲染器", () => {
  const js = buildTheGoodsAndGuardRenderer();
  const categories = ["fashion", "travel"];

  it("语法合法且被判定为渲染器", () => {
    assert.equal(checkJsSyntax(js).ok, true);
    assert.equal(looksLikeRenderer(js), true);
  });

  function run(entries: unknown[]) {
    const { document, store, chips } = makeDom({
      chips: ["all", "Clothing & Accessories", "Travel & Accommodation"],
    });
    const data = `var posts = ${JSON.stringify(entries)};`;
    const sandbox = { document, window: { scrollTo: () => undefined }, console };
    runInNewContext(data + "\n" + js, sandbox);
    return { store, chips };
  }

  it("把卡片写进 #articleGrid", () => {
    const { store } = run(makeEntries(14, categories));
    assert.equal((String(store.articleGrid.innerHTML).match(/class="tgg-post-card"/g) || []).length, 9);
  });

  it("点击分类按钮（Travel & Accommodation）只展示该分类", () => {
    const { store, chips } = run(makeEntries(14, categories));
    const travel = chips.find((c) => c.getAttribute("data-category") === "Travel & Accommodation")!;
    travel.click();
    const html = String(store.articleGrid.innerHTML);
    assert.ok(html.includes("Title 1"));
    assert.ok(!html.includes(">Title 0<"));
  });

  it("没有 undefined", () => {
    const { store } = run(makeEntries(6, categories));
    assert.ok(!String(store.articleGrid.innerHTML).includes("undefined"));
  });

  it("空数据提示而不是空白", () => {
    const { store } = run([]);
    assert.ok(String(store.articleGrid.innerHTML).includes("No stories found"));
  });
});

describe("D-370 everydaynes.top 专属渲染器", () => {
  const js = buildEverydaynesRenderer();

  it("语法合法且被判定为渲染器", () => {
    assert.equal(checkJsSyntax(js).ok, true);
    assert.equal(looksLikeRenderer(js), true);
  });

  function run(entries: unknown[]) {
    const { document, store } = makeDom({ categoryTagsIsEmpty: true });
    const data = `var posts = ${JSON.stringify(entries)};`;
    const sandbox = { document, window: { scrollTo: () => undefined }, console };
    runInNewContext(data + "\n" + js, sandbox);
    return { store };
  }

  it("把卡片写进 #articleGrid", () => {
    const { store } = run(makeEntries(14, ["travel", "lifestyle"]));
    assert.equal((String(store.articleGrid.innerHTML).match(/class="ed-post-card"/g) || []).length, 9);
  });

  it("categoryTags 容器被动态填充分类按钮", () => {
    const { store } = run(makeEntries(6, ["travel"]));
    const html = String(store.categoryTags.innerHTML);
    assert.ok(html.includes("Travel &amp; Stay"), "esc() 会把 & 转义成 &amp;");
    assert.ok(html.includes('data-category="all"'));
  });

  it("库里混进的两种 category 格式（短 key / 长名小写）都映射成同一个标签", () => {
    const { store } = run([
      ...makeEntries(1, ["travel"]),
      ...makeEntries(1, ["travel & stay"]),
    ]);
    const html = String(store.articleGrid.innerHTML);
    assert.equal((html.match(/Travel &amp; Stay/g) || []).length, 2, "两种格式都该映射成同一个标签");
  });

  it("没有 undefined", () => {
    const { store } = run(makeEntries(6, ["travel"]));
    assert.ok(!String(store.articleGrid.innerHTML).includes("undefined"));
  });

  it("空数据提示而不是空白", () => {
    const { store } = run([]);
    assert.ok(String(store.articleGrid.innerHTML).includes("No articles found"));
  });
});
