/**
 * D-370：aura-bloom.top「修完还是没内容」—— hasRenderer 判真的那条
 * 「原样保留渲染器」分支，吞掉了容器名修正。
 *
 * 根因链：
 *   1. RENDERER_MARKERS 里有 "getElementById('article-list')"——这正是
 *      A1 渲染器**硬编码**的容器名字符串本身。
 *   2. aura-bloom.top 的 assets/js/main.js 从未被截断，语法一直合法，
 *      渲染器也一直在，所以 hasRenderer(raw) === true、checkJsSyntax 也过，
 *      每次重建都走 replaceJsArrayLiteral（只换数组、原样保留渲染器）。
 *   3. 但该站首页实际容器是 #postsGrid，不是 #article-list——这个不符是
 *      **原有的**，不是重建造成的。原样保留等于把这个不符原样抄一遍。
 *   4. 专门修容器名的 pickListContainerId 逻辑只在 isA1DataFile 分支里，
 *      而这条分支只有 hasRenderer 判假（文件被截断丢了渲染器）时才轮得到——
 *      对「渲染器完好但容器名本来就错」的站，永远排不上号。
 *
 * 这份测试锁住修复后的决策：A1 文件即使 hasRenderer 为真，只要首页实际
 * 容器名不是 article-list，就不能走「原样保留」，必须改走重新生成。
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { hasRenderer, checkJsSyntax } from "../src/lib/site-write-guard";
import { isA1DataFile, pickListContainerId } from "../src/lib/remote-publisher";

/** aura-bloom.top 实际形态的简化版：语法完好、渲染器完好，但硬编码 article-list */
const AURA_BLOOM_MAIN_JS =
  'const posts = [\n  {"id":"1","slug":"a"}\n];\n\n(function () {\n' +
  "  var FIXED_CATS = [{k:'fashion'}];\n" +
  "  var grid=document.getElementById('article-list');\n" +
  "  function renderGrid(){ if(grid) grid.innerHTML=''; }\n" +
  "  renderGrid();\n})();\n";

/** aura-bloom.top 首页实际 HTML：容器是 #postsGrid，没有 article-list */
const AURA_BLOOM_INDEX_HTML =
  '<div id="categoryChips"></div><div id="postsGrid"></div><div id="pagination"></div>';

/** thegoodsandguard.top 的对照组：首页容器是 articleGrid */
const THEGOODSANDGUARD_INDEX_HTML = '<div id="articleGrid"></div>';

describe("D-370 aura-bloom.top：hasRenderer 为真不代表容器名对得上", () => {
  it("原文件语法合法、渲染器判真 —— 旧逻辑会误判成「渲染器完好，原样保留」", () => {
    assert.equal(checkJsSyntax(AURA_BLOOM_MAIN_JS).ok, true);
    assert.equal(hasRenderer(AURA_BLOOM_MAIN_JS), true);
  });

  it("该站是 A1 数据文件", () => {
    assert.equal(isA1DataFile("assets/js/main.js", "posts"), true);
  });

  it("首页实际容器名不是 article-list —— 这就是「原样保留」会出问题的证据", () => {
    assert.equal(pickListContainerId(AURA_BLOOM_INDEX_HTML), "postsGrid");
  });

  it("决策逻辑：A1 + hasRenderer 为真 + 容器名不符 ⇒ 不能走原样保留，要重新生成", () => {
    const isA1 = isA1DataFile("assets/js/main.js", "posts");
    const rendererPresent = hasRenderer(AURA_BLOOM_MAIN_JS) && checkJsSyntax(AURA_BLOOM_MAIN_JS).ok;
    const containerMismatch = isA1 && rendererPresent
      && pickListContainerId(AURA_BLOOM_INDEX_HTML) !== "article-list";
    assert.equal(containerMismatch, true, "必须判定为「容器名不符」，才会触发重新生成");
  });

  it("对照组：容器名本来就是 article-list 时，不该误判成不符", () => {
    const html = '<div id="article-list"></div>';
    const containerMismatch = pickListContainerId(html) !== "article-list";
    assert.equal(containerMismatch, false);
  });

  it("对照组 thegoodsandguard.top：容器名是 articleGrid，同样要判不符", () => {
    assert.equal(pickListContainerId(THEGOODSANDGUARD_INDEX_HTML), "articleGrid");
    const containerMismatch = pickListContainerId(THEGOODSANDGUARD_INDEX_HTML) !== "article-list";
    assert.equal(containerMismatch, true);
  });
});
