/**
 * D-370：omniluxe.top「首页又没内容了」—— 实测是 TypeError，不是白屏。
 *
 * 该站数据+渲染器同住 assets/app.js。原模板字段是 categories（数组）+
 * articleUrl + displayDate；CRM 发布新文章时曾直接用标准字段插入，
 * 新旧条目字段名对不上，渲染器对新条目跑 post.categories.join() 时
 * 因 categories 是 undefined 直接报错，#postGrid 保持空。
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { runInNewContext } from "node:vm";
import { fixOmniluxeFieldMismatch } from "../src/lib/site-templates/omniluxe-field-fix";
import { checkJsSyntax } from "../src/lib/site-write-guard";

/** 线上真实形状的简化版：7 条 CRM 标准字段 + 5 条原生 categories 字段 */
function makeScriptJs(): string {
  const crmEntries = [
    { id: "2119", slug: "marriott", title: "Marriott", category: "travel", date: "2026-05-27", dateISO: "2026-05-27", dateLabel: "May 27, 2026", readTime: "6 min read", excerpt: "excerpt", image: "/images/a.png", heroImage: "/images/a.png", detailUrl: "post-marriott", tags: ["travel"] },
    { id: "6820", slug: "hockeymonkey", title: "Hockeymonkey", category: "lifestyle", date: "2026-09-05", dateISO: "2026-09-05", dateLabel: "Sep 5, 2026", readTime: "4 min read", excerpt: "excerpt2", image: "/images/b.webp", heroImage: "/images/b.webp", detailUrl: "post-hockeymonkey", tags: ["lifestyle"] },
  ];
  const nativeEntries = [
    { slug: "tailored-revival", title: "Tailored Revival", categories: ["Clothing & Accessories"], date: "2025-01-18", displayDate: "January 18, 2025", excerpt: "native excerpt", image: "https://images.unsplash.com/x", articleUrl: "articles/tailored-revival.html" },
  ];
  const posts = [...crmEntries, ...nativeEntries];
  return `const posts = ${JSON.stringify(posts, null, 2)};

function renderPosts() {
  postGrid.innerHTML = posts.map((post) => \`
    <article class="post-card">
      <span>\${post.categories.join(" · ")}</span>
      <span>\${post.displayDate}</span>
      <a href="\${post.articleUrl}">Read Story</a>
    </article>
  \`).join("");
}
`;
}

describe("D-370 omniluxe.top 字段名不匹配一次性修复", () => {
  it("能找出 CRM 标准字段条目并转换，原生条目不动", () => {
    const { patched, fixedCount } = fixOmniluxeFieldMismatch(makeScriptJs());
    assert.ok(patched);
    assert.equal(fixedCount, 2, "两条 CRM 标准字段条目该被转换");
  });

  it("转换后语法合法", () => {
    const { patched } = fixOmniluxeFieldMismatch(makeScriptJs());
    assert.ok(patched);
    assert.equal(checkJsSyntax(patched!).ok, true);
  });

  it("转换后的条目字段是 categories/articleUrl/displayDate，不再是 category/detailUrl", () => {
    const { patched } = fixOmniluxeFieldMismatch(makeScriptJs());
    assert.ok(patched);
    const m = /const posts = (\[[\s\S]*?\n\]);/.exec(patched!);
    assert.ok(m);
    const posts = JSON.parse(m![1]) as Record<string, unknown>[];
    const marriott = posts.find((p) => p.slug === "marriott")!;
    assert.ok(Array.isArray(marriott.categories), "应转换成数组字段");
    assert.equal(typeof marriott.articleUrl, "string");
    assert.equal(marriott.category, undefined, "不该再保留旧字段");
    assert.equal(marriott.detailUrl, undefined, "不该再保留旧字段");
  });

  it("用真实渲染器跑：转换后不再报错、categories.join 正常工作", () => {
    const { patched } = fixOmniluxeFieldMismatch(makeScriptJs());
    assert.ok(patched);

    let gridHTML = "";
    const postGrid = { set innerHTML(v: string) { gridHTML = v; } };
    const sandbox: Record<string, unknown> = { postGrid, console };
    assert.doesNotThrow(() => {
      runInNewContext(patched + "; renderPosts();", sandbox);
    });
    assert.ok(!gridHTML.includes("undefined"));
    assert.ok(gridHTML.includes("Travel & Accommodation") || gridHTML.includes("Lifestyle"));
  });

  it("原生 articleUrl 条目的链接保持不变", () => {
    const { patched } = fixOmniluxeFieldMismatch(makeScriptJs());
    assert.ok(patched);
    assert.ok(patched!.includes("articles/tailored-revival.html"));
  });

  it("没有脏数据时返回 patched:null（幂等，补丁可以安全重跑）", () => {
    const clean = `const posts = ${JSON.stringify([
      { slug: "a", title: "A", categories: ["Travel"], date: "2026-01-01", displayDate: "Jan 1, 2026", excerpt: "e", image: "/i.png", articleUrl: "/post-a/" },
    ])};`;
    const { patched, fixedCount } = fixOmniluxeFieldMismatch(clean);
    assert.equal(patched, null);
    assert.equal(fixedCount, 0);
  });

  it("找不到 const posts 声明时返回 patched:null（文件已被换成别的版本）", () => {
    const { patched } = fixOmniluxeFieldMismatch("function other() { return 1; }");
    assert.equal(patched, null);
  });
});
