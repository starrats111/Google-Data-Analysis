/**
 * D-370：「渲染器读的数组变量名和数据文件声明的对不上」这一类故障的回归。
 *
 * 这是我漏掉、被 01 当场抓住的一类。allurahub.top / vitahaven.click 修完截断后，
 * 我验了「语法 ok + 渲染器在 + 文章页 200」就报「已修好」，但 01 打开首页仍然是空的。
 *
 * 真因：数据文件 js/articles-index.js 声明 `const articlesIndex = [...]`，
 * 而渲染器 js/main.js 第 70 行是 `displayArticles(articles, 1)` ——
 * 全局 `articles` 从未被任何文件定义，脚本一跑就 ReferenceError，
 * 整个 DOMContentLoaded 处理器中断，首页什么都不画。
 *
 * 关键点：这个不匹配是**原有的**（修复前的 .bak 里也声明 articlesIndex），
 * 和截断无关。所以「修完截断」不等于「首页有内容」—— 两者得分开验。
 * 旧判据对它完全失明：两个文件各自语法都合法、渲染器也确实存在，只是对不上。
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { findUnresolvedArrayVars, checkJsSyntax, looksLikeRenderer } from "../src/lib/site-write-guard";

// 线上实际形状（照抄 allurahub.top 的两个文件的关键部分）
const DATA_FILE = {
  path: "js/articles-index.js",
  content: '// 文章索引 - 生成于 2026-02-13T00:55:38.173Z\n'
    + 'const articlesIndex = [\n  {"id":"8082","slug":"a","title":"A"}\n];\n',
};
const RENDERER_READS_ARTICLES = {
  path: "js/main.js",
  content: `
document.addEventListener('DOMContentLoaded', function () {
  const currentPage = location.pathname.split('/').pop();
  if (currentPage === 'index.html' || currentPage === '') {
    displayArticles(articles, 1);
  }
});
function displayArticles(articlesToShow, page) {
  const articlesGrid = document.getElementById('articlesGrid');
  if (!articlesGrid) return;
  articlesGrid.innerHTML = '';
  articlesToShow.slice(0, 6).forEach(function (a) { articlesGrid.appendChild(document.createElement('div')); });
}
function getFilteredArticles() { let filtered = articles; return filtered; }
`,
};

describe("D-370 变量名不匹配（修完截断仍白屏的真因）", () => {
  it("两个文件各自语法都合法 —— 所以语法校验发现不了", () => {
    assert.equal(checkJsSyntax(DATA_FILE.content).ok, true);
    assert.equal(checkJsSyntax(RENDERER_READS_ARTICLES.content).ok, true);
  });

  it("渲染器也确实存在 —— 所以「渲染器在不在」也发现不了", () => {
    assert.equal(looksLikeRenderer(RENDERER_READS_ARTICLES.content), true);
  });

  it("新判据能抓出来：articles 没人定义", () => {
    const missing = findUnresolvedArrayVars([DATA_FILE, RENDERER_READS_ARTICLES]);
    assert.deepEqual(missing, ["articles"], "应报 articles 未定义");
  });

  it("补上桥接别名后判据放行", () => {
    const bridged = {
      path: DATA_FILE.path,
      content: DATA_FILE.content + "\nvar articles = articlesIndex;\n",
    };
    assert.deepEqual(findUnresolvedArrayVars([bridged, RENDERER_READS_ARTICLES]), []);
  });

  it("数据和渲染器同体的 A1 站不会被误报", () => {
    const a1 = {
      path: "assets/js/main.js",
      content: 'const posts = [\n  {"id":"1"}\n];\n'
        + "(function(){ var grid=document.getElementById('article-list');"
        + " posts.slice(0,6).forEach(function(p){ grid.innerHTML += p.title; }); })();",
    };
    assert.deepEqual(findUnresolvedArrayVars([a1]), [], "自产自用，不该报");
  });

  it("非 A1 但变量名一致的站不会被误报", () => {
    const data = { path: "js/data.js", content: 'const articles = [{"id":"1"}];' };
    const rend = {
      path: "js/main.js",
      content: "var g=document.getElementById('grid'); articles.forEach(function(a){ g.innerHTML+=a.title; });",
    };
    assert.deepEqual(findUnresolvedArrayVars([data, rend]), []);
  });

  it("window.__ARTICLES__ 那类赋值也算声明", () => {
    const data = { path: "js/d.js", content: 'window.__ARTICLES__ = [{"id":"1"}];' };
    const rend = {
      path: "js/m.js",
      content: "var g=document.getElementById('g'); window.__ARTICLES__.forEach(function(a){ g.innerHTML+=a.title; });",
    };
    assert.deepEqual(findUnresolvedArrayVars([data, rend]), []);
  });

  it("只是提到名字、没当数组用，不算（避免误报）", () => {
    const data = { path: "js/d.js", content: 'const posts = [{"id":"1"}];' };
    const rend = {
      path: "js/m.js",
      content: "var g=document.getElementById('g');"
        + " g.innerHTML = 'We will keep you updated with our latest articles.';"
        + " posts.forEach(function(p){ g.innerHTML+=p.title; });",
    };
    assert.deepEqual(findUnresolvedArrayVars([data, rend]), [],
      "文案里的 articles 这个词不该被当成变量引用");
  });
});
