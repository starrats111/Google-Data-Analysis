import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { patchQuibloFeaturedFallback } from "../src/lib/site-templates/quiblo-featured-fallback";
import { checkJsSyntax } from "../src/lib/site-write-guard";
import { runInNewContext } from "node:vm";

// 真实 quiblo.top script.js 里 displayFeaturedArticles 的样子（简化版，缩进
// 和锚点字符串保持一致，否则 patchQuibloFeaturedFallback 会因为匹配不到而拒绝）
function makeScript(): string {
  const lines = [
    "function displayFeaturedArticles() {",
    "    const featuredArticlesContainer = document.getElementById('featuredArticles');",
    "    if (!featuredArticlesContainer) return;",
    "",
    "    const featured = blogPosts",
    "        .filter(post => post.featured === true)",
    "        .sort((a, b) => new Date(b.date) - new Date(a.date));",
    "",
    "    if (featured.length === 0) {",
    "        featuredArticlesContainer.innerHTML = '<p>No featured.</p>';",
    "        return;",
    "    }",
    "",
    "    featuredArticlesContainer.innerHTML = featured.map(post => `<article>${post.title}</article>`).join('');",
    "}",
  ];
  return lines.join("\n");
}

describe("D-370 quiblo.top 精选文章兜底补丁", () => {
  it("能命中真实形态的锚点文本，返回补丁后的内容", () => {
    const patched = patchQuibloFeaturedFallback(makeScript());
    assert.notEqual(patched, null);
  });

  it("锚点文本不存在时拒绝盲改，返回 null", () => {
    const patched = patchQuibloFeaturedFallback("function other() { return 1; }");
    assert.equal(patched, null);
  });

  it("补丁后的内容语法合法", () => {
    const patched = patchQuibloFeaturedFallback(makeScript());
    assert.ok(patched);
    assert.equal(checkJsSyntax(patched!).ok, true);
  });

  it("用真实数据跑：筛不出精选时退回最新 3 篇，不报 undefined", () => {
    const patched = patchQuibloFeaturedFallback(makeScript());
    assert.ok(patched);

    const posts = [
      { title: "Old Post", date: "2026-01-01" },
      { title: "New Post", date: "2026-10-01" },
      { title: "Mid Post", date: "2026-05-01" },
    ];
    let capturedHtml = "";
    const container = { set innerHTML(v: string) { capturedHtml = v; } };
    const document = { getElementById: (id: string) => (id === "featuredArticles" ? container : null) };
    const sandbox: Record<string, unknown> = { document, blogPosts: posts, console };
    runInNewContext(patched + "; displayFeaturedArticles();", sandbox);

    assert.ok(capturedHtml.includes("New Post"), "最新那篇该出现");
    assert.ok(!capturedHtml.includes("undefined"), "不该有 undefined");
    assert.equal((capturedHtml.match(/<article>/g) || []).length, 3, "退回展示 3 篇");
  });
});
