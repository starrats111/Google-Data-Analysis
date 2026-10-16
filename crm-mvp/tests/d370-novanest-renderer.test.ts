/**
 * D-370：抢救并补全的 novanest.one 渲染器回归。
 *
 * 该站的 scripts.js 装着「数据 + 渲染器」，截断后渲染器断在
 * `prevBtn.disabled = ` 这一句中间，首页白屏。没有 .bak / 备份目录 / .git，
 * 也没有同模板的别的站可抄；但渲染器主体还在文件里，所以抄出来补全
 * （01 在「补全并改字段名」与「整站改造成 A1」之间选了前者）。
 *
 * 这个测试必须真的把生成的 JS 跑起来 —— 只做语法校验是不够的：
 * 该站的数据早被 CRM 的字段格式覆盖（只有 dateLabel / readTime / detailUrl，
 * 而原渲染器读 displayDate / readingTime / detailPage），11 个字段里缺 5 个。
 * 不改字段名的话语法照样合法，但卡片上会是一片 undefined。
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { runInNewContext } from "node:vm";
import { buildNovanestScriptsJs } from "../src/lib/site-templates/novanest-renderer";
import { checkJsSyntax } from "../src/lib/site-write-guard";

/** 线上那批条目的真实字段形状（CRM 写的那套） */
const SAMPLE = [
  {
    id: "7001", slug: "a-first-post", title: "A First Post",
    category: "fashion", date: "2026-09-01", dateISO: "2026-09-01",
    dateLabel: "Sep 1, 2026", readTime: "4 min read",
    excerpt: "First excerpt", image: "/images/articles/1.webp",
    heroImage: "/images/articles/1.webp", detailUrl: "post-a-first-post",
    tags: ["fashion"],
  },
  {
    id: "7002", slug: "b-second-post", title: "B Second Post",
    category: "home-garden", date: "2026-08-20", dateISO: "2026-08-20",
    dateLabel: "Aug 20, 2026", readTime: "7 min read",
    excerpt: "Second excerpt", image: "", heroImage: "",
    detailUrl: "post-b-second-post", tags: ["home"],
  },
  {
    id: "7003", slug: "c-third-post", title: "C Third Post",
    category: "fashion", date: "2026-07-05", dateISO: "2026-07-05",
    dateLabel: "Jul 5, 2026", readTime: "3 min read",
    excerpt: "Third excerpt", image: "/images/articles/3.webp",
    heroImage: "/images/articles/3.webp", detailUrl: "post-c-third-post",
    tags: [],
  },
  {
    id: "7004", slug: "d-fourth-post", title: "D Fourth Post",
    category: "travel", date: "2026-06-11", dateISO: "2026-06-11",
    dateLabel: "Jun 11, 2026", readTime: "5 min read",
    excerpt: "Fourth excerpt", image: "", heroImage: "",
    detailUrl: "post-d-fourth-post", tags: ["travel"],
  },
];

/** 极简 DOM 替身：只实现这个渲染器用到的那几样 */
function makeDom() {
  const mk = (id: string) => {
    const el: Record<string, unknown> = {
      id, innerHTML: "", textContent: "", value: "", disabled: false,
      className: "", children: [] as unknown[],
      listeners: {} as Record<string, Array<() => void>>,
    };
    el.addEventListener = (ev: string, fn: () => void) => {
      const ls = el.listeners as Record<string, Array<() => void>>;
      (ls[ev] = ls[ev] || []).push(fn);
    };
    el.appendChild = (c: unknown) => { (el.children as unknown[]).push(c); };
    el.querySelectorAll = () => [];
    return el;
  };

  const ids = ["postsContainer", "categoryFilter", "searchInput", "pageInfo", "prevPage", "nextPage", "quickCategories"];
  const store: Record<string, Record<string, unknown>> = {};
  for (const i of ids) store[i] = mk(i);

  const document = {
    readyState: "complete",
    getElementById: (id: string) => store[id] || null,
    addEventListener: () => undefined,
    createElement: () => mk("created"),
    querySelectorAll: () => [],
  };
  return { document, store };
}

describe("D-370 novanest.one 抢救出的渲染器", () => {
  const js = buildNovanestScriptsJs(JSON.stringify(SAMPLE, null, 2));

  it("生成的文件语法合法", () => {
    const r = checkJsSyntax(js);
    assert.equal(r.ok, true, r.error || "");
  });

  it("含渲染代码（会被巡检判为「渲染器在」）", () => {
    assert.ok(js.includes("getElementById"), "应操作 DOM");
    assert.ok(js.includes("innerHTML"), "应写 innerHTML");
  });

  it("真的跑起来并把卡片写进 #postsContainer", () => {
    const { document, store } = makeDom();
    runInNewContext(js, { document, console });
    const container = store.postsContainer;
    assert.equal((container.children as unknown[]).length, 3, "每页 3 条（POSTS_PER_PAGE=3）");
  });

  it("卡片里没有 undefined —— 字段名改写生效了", () => {
    const { document, store } = makeDom();
    runInNewContext(js, { document, console });
    const cards = store.postsContainer.children as Array<Record<string, unknown>>;
    for (const c of cards) {
      const html = String(c.innerHTML);
      assert.ok(!html.includes("undefined"), `卡片里不能有 undefined：${html.slice(0, 160)}`);
    }
  });

  it("卡片用上了 CRM 的字段（dateLabel / readTime / detailUrl）", () => {
    const { document, store } = makeDom();
    runInNewContext(js, { document, console });
    const html = (store.postsContainer.children as Array<Record<string, unknown>>)
      .map((c) => String(c.innerHTML)).join("");
    assert.ok(html.includes("Sep 1, 2026"), "应显示 dateLabel");
    assert.ok(html.includes("4 min read"), "应显示 readTime");
    assert.ok(html.includes("/post-a-first-post/"), "链接应来自 detailUrl");
    assert.ok(html.includes("Fashion"), "categoryLabel 应由 category 现算");
    assert.ok(html.includes("Home Garden"), "带连字符的分类也要算对");
  });

  it("去掉了产品精选入口（CRM 没有这两个字段，01 已确认可去）", () => {
    // 判「代码里不再**读取**这两个字段」，而不是「文件里不出现这个词」——
    // 注释里会提到它们为什么被去掉，那不算引用。
    assert.ok(!/\bp(?:ost)?\.productHighlight\b/.test(js), "不应再读取 post.productHighlight");
    assert.ok(!/\bp(?:ost)?\.productPage\b/.test(js), "不应再读取 post.productPage");
    assert.ok(!js.includes("View product picks"), "不应再有产品精选按钮");
  });

  it("分页状态算对：首页 prev 禁用、next 可用", () => {
    const { document, store } = makeDom();
    runInNewContext(js, { document, console });
    assert.equal(store.pageInfo.textContent, "1 / 2", "4 条 / 每页 3 条 = 2 页");
    assert.equal(store.prevPage.disabled, true, "第 1 页 prev 应禁用");
    assert.equal(store.nextPage.disabled, false, "还有下一页，next 不该禁用");
  });

  it("缺图的条目用占位，不生成 src 为空的 img", () => {
    const { document, store } = makeDom();
    runInNewContext(js, { document, console });
    const html = (store.postsContainer.children as Array<Record<string, unknown>>)
      .map((c) => String(c.innerHTML)).join("");
    assert.ok(!html.includes('src=""'), "不该出现空 src");
    assert.ok(html.includes("nv-card-thumb-ph"), "缺图应走占位");
  });

  it("标题里的尖括号被转义（防 XSS 与破版）", () => {
    const evil = [{ ...SAMPLE[0], title: '<img src=x onerror=alert(1)>' }];
    const { document, store } = makeDom();
    runInNewContext(buildNovanestScriptsJs(JSON.stringify(evil, null, 2)), { document, console });
    const html = String((store.postsContainer.children as Array<Record<string, unknown>>)[0].innerHTML);
    assert.ok(!html.includes("<img src=x"), "原样的标签不能进 DOM");
    assert.ok(html.includes("&lt;img"), "应被转义");
  });
});
