/**
 * D-370：变量桥接检测逻辑的回归。
 *
 * 为什么要单独测这个：桥接代码写出来后**一直没生效**，allurahub.top 修完仍然
 * `ReferenceError: articles is not defined`。真因是模板字符串里写了单反斜杠：
 *     new RegExp(`\b${cand}\b`)
 * 模板串里的 `\b` 是**退格字符**（字符码 8），不是正则的词边界，所以那个正则
 * 永远匹配不上。实测 `.source` 的字符码是 8,97,...,8 才确认的。
 *
 * 这类错 tsc 和 eslint 都不报、单元测试不覆盖的话就只能靠线上行为发现 ——
 * 我就是让 01 第四次打开页面才发现的。所以这里把判定逻辑单独拎出来测。
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";

/** 与 buildRendererVarBridge 里的判定逻辑一致 */
function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

const VAR_NAMES = [
  "articlesIndex", "articles", "ARTICLES", "posts", "blogPosts", "POSTS", "articlesData",
];

function neededBridges(rendererSrc: string, declaredVar: string): string[] {
  const needed: string[] = [];
  for (const cand of VAR_NAMES) {
    if (cand === declaredVar) continue;
    const used = new RegExp(`\\b${escapeRegExp(cand)}\\b`).test(rendererSrc);
    const declared = new RegExp(`(?:const|var|let)\\s+${escapeRegExp(cand)}\\s*=`).test(rendererSrc);
    if (used && !declared) needed.push(cand);
  }
  return needed;
}

// allurahub.top 的真实渲染器片段（js/main.js 第 70 行那段）
const ALLURAHUB_RENDERER = `
document.addEventListener('DOMContentLoaded', function () {
  if (currentPage === 'index.html' || currentPage === '') {
    displayArticles(articles, 1);
  }
});
function getFilteredArticles() { let filtered = articles; return filtered; }
`;

describe("D-370 变量桥接检测", () => {
  it("锁住那个 bug：模板串里的 \\b 是退格字符，不是词边界", () => {
    const BS = String.fromCharCode(92);
    // 模板串里写单反斜杠的效果（当年的写法）
    const broken = new RegExp(`\b${"articles"}\b`);
    assert.equal(broken.source.charCodeAt(0), 8, "第一个字符应是退格符（码 8）");
    assert.equal(broken.test("displayArticles(articles, 1);"), false, "所以永远匹配不上");

    // 双反斜杠才对
    const fixed = new RegExp(`${BS}${BS}b${"articles"}${BS}${BS}b`.replace(/\\\\/g, "\\"));
    assert.equal(fixed.source, "\\barticles\\b");
    assert.equal(fixed.test("displayArticles(articles, 1);"), true);
  });

  it("allurahub 形态：数据声明 articlesIndex、渲染器读 articles → 需要桥接", () => {
    const needed = neededBridges(ALLURAHUB_RENDERER, "articlesIndex");
    assert.ok(needed.includes("articles"), `应报需要桥接 articles，实际 ${JSON.stringify(needed)}`);
  });

  it("渲染器自己声明了就不桥接", () => {
    const src = "let articles = window.__ARTICLES__ || []; articles.forEach(function(a){});";
    assert.deepEqual(neededBridges(src, "articlesIndex"), [], "aurislane 那种自己转换的不该桥接");
  });

  it("名字一致时不桥接", () => {
    const src = "articlesIndex.forEach(function(a){ grid.innerHTML += a.title; });";
    assert.deepEqual(neededBridges(src, "articlesIndex"), []);
  });

  it("词边界生效：articlesIndex 不会被 articles 误命中", () => {
    const src = "articlesIndex.slice(0,6).forEach(function(a){});";
    const needed = neededBridges(src, "articlesIndex");
    assert.ok(!needed.includes("articles"),
      "没有词边界的话 articles 会在 articlesIndex 里误命中，凭空造出一行桥接");
  });
});
