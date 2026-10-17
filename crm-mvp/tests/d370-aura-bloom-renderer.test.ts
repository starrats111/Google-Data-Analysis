/**
 * D-370：aura-bloom.top 的专属渲染器回归。
 *
 * 该站先踩了容器名不符（article-list vs postsGrid，另一个 PR 修的），
 * 容器名修完之后 apply 实测又炸了：A1 模板里 secKicker/secTitle 等一堆
 * 其它容器在这个站上不存在、且没有空值保护，脚本跑两步就因
 * `null.textContent=...` TypeError 整个中断。查实该站首页布局
 * （categoryChips 分类按钮/searchInput 搜索框/resultsCount 结果计数/
 * postsGrid 卡片网格/pagination 分页）和 A1 模板完全不是一回事，需要
 * 专属渲染器。
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { runInNewContext } from "node:vm";
import { buildAuraBloomRenderer } from "../src/lib/site-templates/aura-bloom-renderer";
import { checkJsSyntax, looksLikeRenderer } from "../src/lib/site-write-guard";

function makeEntries(n: number) {
  return Array.from({ length: n }, (_, i) => ({
    id: String(8000 + i),
    slug: `post-slug-${i}`,
    title: `Title ${i}`,
    category: i % 2 ? "travel" : "fashion",
    date: `2026-10-${String(28 - i).padStart(2, "0")}`,
    dateISO: `2026-10-${String(28 - i).padStart(2, "0")}`,
    dateLabel: `Oct ${28 - i}, 2026`,
    readTime: "4 min read",
    excerpt: `Excerpt ${i}`,
    image: i === 3 ? "" : `/images/articles/${8000 + i}_0.webp`,
    heroImage: i === 3 ? "" : `/images/articles/${8000 + i}_0.webp`,
    detailUrl: `post-title-${i}`,
    tags: ["travel"],
  }));
}

/** 可点击的分类按钮：有 getAttribute/classList/addEventListener */
function makeChip(category: string, active = false) {
  const classes = new Set<string>(active ? ["ab-chip", "is-active"] : ["ab-chip"]);
  const listeners: Array<() => void> = [];
  return {
    getAttribute: (name: string) => (name === "data-category" ? category : null),
    classList: {
      add: (c: string) => classes.add(c),
      remove: (c: string) => classes.delete(c),
      has: (c: string) => classes.has(c),
    },
    addEventListener: (ev: string, fn: () => void) => { if (ev === "click") listeners.push(fn); },
    click() {
      const self = this;
      listeners.forEach((fn) => fn.call(self));
    },
  };
}

function makeDom(categories: string[]) {
  const mk = (id: string) => {
    const el: Record<string, unknown> = {
      id, innerHTML: "", textContent: "",
      listeners: {} as Record<string, Array<() => void>>,
    };
    el.addEventListener = (ev: string, fn: () => void) => {
      const ls = el.listeners as Record<string, Array<() => void>>;
      (ls[ev] = ls[ev] || []).push(fn);
    };
    el.querySelectorAll = () => [];
    return el;
  };
  const chips = ["all", ...categories].map((c, i) => makeChip(c, i === 0));
  const store: Record<string, Record<string, unknown>> = {
    postsGrid: mk("postsGrid"),
    pagination: mk("pagination"),
    resultsCount: mk("resultsCount"),
    searchInput: mk("searchInput"),
  };
  (store.searchInput as Record<string, unknown>).value = "";
  const document = {
    readyState: "complete",
    getElementById: (id: string) => store[id] || null,
    querySelectorAll: (sel: string) => (sel === "[data-category]" ? chips : []),
    addEventListener: () => undefined,
  };
  return { document, store, chips };
}

function run(entries: unknown[], categories = ["Fashion & Accessories", "Travel & Stays"]) {
  const { document, store, chips } = makeDom(categories);
  const data = `var posts = ${JSON.stringify(entries)};`;
  const sandbox = { document, window: { scrollTo: () => undefined }, console };
  runInNewContext(data + "\n" + buildAuraBloomRenderer(), sandbox);
  return { store, chips };
}

describe("D-370 aura-bloom.top 专属渲染器", () => {
  const js = buildAuraBloomRenderer();

  it("语法合法且被判定为渲染器", () => {
    assert.equal(checkJsSyntax(js).ok, true);
    assert.equal(looksLikeRenderer(js), true);
  });

  it("独立成文件：不含数据声明", () => {
    assert.ok(!/(?:const|var|let)\s+posts\s*=\s*\[/.test(js));
  });

  it("把卡片写进 #postsGrid，每页 9 条", () => {
    const { store } = run(makeEntries(14));
    const html = String(store.postsGrid.innerHTML);
    assert.equal((html.match(/class="ab-post-card"/g) || []).length, 9);
  });

  it("resultsCount 显示总条数", () => {
    const { store } = run(makeEntries(14));
    assert.equal(String(store.resultsCount.textContent), "14");
  });

  it("点击分类按钮后只展示该分类，resultsCount 同步更新", () => {
    const { store, chips } = run(makeEntries(14));
    const travelChip = chips.find((c) => c.getAttribute("data-category") === "Travel & Stays")!;
    travelChip.click();
    const html = String(store.postsGrid.innerHTML);
    assert.equal(String(store.resultsCount.textContent), "7", "14 条奇偶各半，travel 应是 7 条");
    assert.ok(html.includes("Title 1"), "奇数下标是 travel");
    assert.ok(!html.includes(">Title 0<"), "偶数下标是 fashion，不该出现");
  });

  it("卡片里没有 undefined", () => {
    const { store } = run(makeEntries(6));
    assert.ok(!String(store.postsGrid.innerHTML).includes("undefined"));
  });

  it("缺图走占位，不生成空 src", () => {
    const { store } = run(makeEntries(6));
    const html = String(store.postsGrid.innerHTML);
    assert.ok(!html.includes('src=""'));
    assert.ok(html.includes("ab-post-card-ph"));
  });

  it("空数据时显示提示而不是空白网格", () => {
    const { store } = run([]);
    assert.ok(String(store.postsGrid.innerHTML).includes("No stories found"));
  });

  it("标题被转义", () => {
    const e = makeEntries(1);
    (e[0] as Record<string, unknown>).title = '<img src=x onerror=alert(1)>';
    const { store } = run(e);
    const html = String(store.postsGrid.innerHTML);
    assert.ok(!html.includes("<img src=x"));
    assert.ok(html.includes("&lt;img"));
  });

  it("按日期倒序", () => {
    const { store } = run(makeEntries(6));
    const html = String(store.postsGrid.innerHTML);
    assert.ok(html.indexOf("Title 0") < html.indexOf("Title 1"));
  });

  it("category 小写短 key 映射成首页按钮用的长名", () => {
    const e = makeEntries(2);
    (e[0] as Record<string, unknown>).category = "fashion";
    const { store } = run(e);
    assert.ok(String(store.postsGrid.innerHTML).includes("Fashion &amp; Accessories"));
  });
});
