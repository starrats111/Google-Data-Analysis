/**
 * D-370：planRendererVarBridge 的回归。
 *
 * 这是我 apply 修了 vitasphere.top 之后被 01 当场抓到的第二个坑（孤儿文件 bug
 * 修好之后才暴露的）。目标文件改对了（js/articles-index.js），apply 返回
 * 「written_entries: 189」看起来成功，但线上实测首页仍是「No articles found」——
 * 不是白屏，是**假数据**：条目数对、容器也被填了，内容却是空状态提示。
 *
 * 真因：vitasphere.top 原来的 js/articles-index.js 末尾手写了一行
 *   `const blogArticles = articlesIndex;`
 * 数据文件被 buildArrayAssignmentStatement 整体重建时只保留了第一句
 * `const articlesIndex = [...]`，丢了这行手写桥接。而 buildRendererVarBridge
 * 当时在收集「全站已声明的标识符」时**排除了数据文件自身**（`rel !== dataJsPath`），
 * 于是看不到这行旧内容，把 blogArticles 误判成「全站没声明」，补成了
 * `var blogArticles = [];`——覆盖掉了本该正确的桥接关系。
 * displayArticles() 里 `let filteredArticles = blogArticles;` 拿到空数组，
 * 渲染出的就是「No articles found」而不是真实的 189 篇文章。
 *
 * 这个坑比白屏更难发现：脚本正常跑完、容器正常被填、不报任何错误，
 * 只是数据被静默清空了。
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { planRendererVarBridge } from "../src/lib/site-write-guard";

const CANDIDATES = ["articlesIndex", "articles", "ARTICLES", "posts", "blogPosts", "POSTS", "articlesData"];

// vitasphere.top 的真实渲染器形态（照抄线上命中检测的那一行：
// `blogArticles.find(a => {...})`——直接方法调用才会被 findMissingGlobalsWithKind
// 的识别模式捕到；`let x = blogArticles` 这种先赋值再用的形态它识别不了，
// 这不是本次要修的范围，`findUnresolvedArrayVars` 才管这种情形）
const VITASPHERE_RENDERER = `
function displayArticle(slug) {
  const article = blogArticles.find(a => titleToSlug(a.title) === slug);
  if (!article) return;
  const categoryName = categoryNames[article.category] || article.category;
  return categoryName;
}
`;

describe("D-370 planRendererVarBridge：数据文件自身的旧内容必须纳入判断", () => {
  it("重现踩的坑：不把数据文件旧内容纳入 allScripts 时，会把已有桥接误判成缺失", () => {
    // 模拟「排除数据文件自身」的错误调用方式（修复前的行为）
    const allScriptsWithoutDataFile = [{ content: VITASPHERE_RENDERER }];
    const plan = planRendererVarBridge(
      [{ content: VITASPHERE_RENDERER }],
      allScriptsWithoutDataFile,
      "articlesIndex",
      CANDIDATES,
    );
    assert.equal(plan.stubs.get("blogArticles"), "array",
      "不含数据文件旧内容时，blogArticles 会被误判成缺失全局（这正是 bug 复现）");
  });

  it("修复后：把数据文件的旧内容（含手写桥接行）纳入 allScripts，blogArticles 不该被补空壳", () => {
    const oldDataFileContent =
      'const articlesIndex = [\n  {"id":"1","title":"T"}\n];\n'
      + "const blogArticles = articlesIndex;\n";

    const plan = planRendererVarBridge(
      [{ content: VITASPHERE_RENDERER }],
      [{ content: oldDataFileContent }, { content: VITASPHERE_RENDERER }],
      "articlesIndex",
      CANDIDATES,
    );

    assert.equal(plan.stubs.has("blogArticles"), false,
      "blogArticles 原本就被数据文件声明过，不该再补空壳覆盖掉");
    // 这条断言是这次真正要补的洞：光「不补空壳」不够，blogArticles 不在
    // candidateNames（HOMEPAGE_INDEX_VAR_NAMES）里，旧版 planRendererVarBridge
    // 不会把它当候选生成别名 —— 结果是「两边都不管」：新文件里这个变量彻底
    // 没有任何声明，ReferenceError: blogArticles is not defined，比补错空壳更糟。
    // 必须显式断言它出现在 aliases 里，才能保证重建时这行会被重新写回文件。
    assert.ok(plan.aliases.includes("blogArticles"),
      "blogArticles 原本是 articlesIndex 的重导出别名，重建时必须重新生成这行，" +
      "否则两边都不补、新文件里这个变量彻底不存在");
    // categoryNames 确实全站都没声明过（声明在未被引用的 js/data.js 里），应该补
    assert.equal(plan.stubs.get("categoryNames"), "object");
  });

  it("数据文件原本没有额外桥接行时，categoryNames/products 该补空壳的逻辑不受影响", () => {
    const oldDataFileContent = 'const articlesIndex = [\n  {"id":"1"}\n];\n';
    // 用线上真实能触发检测的写法：直接方法调用 / 以标识符为下标索引
    const renderer = `
function f(product) {
  const categoryName = categoryNames[product.category] || 'x';
  return products.filter(p => p.id).length;
}
`;
    const plan = planRendererVarBridge(
      [{ content: renderer }],
      [{ content: oldDataFileContent }, { content: renderer }],
      "articlesIndex",
      CANDIDATES,
    );
    assert.equal(plan.stubs.get("products"), "array");
    assert.equal(plan.stubs.get("categoryNames"), "object");
  });

  it("allurahub 形态：数据数组名不匹配时正确生成别名（不受这次改动影响）", () => {
    const renderer = "displayArticles(articles, 1);";
    const oldDataFileContent = 'const articlesIndex = [\n  {"id":"1"}\n];\n';
    const plan = planRendererVarBridge(
      [{ content: renderer }],
      [{ content: oldDataFileContent }, { content: renderer }],
      "articlesIndex",
      CANDIDATES,
    );
    assert.ok(plan.aliases.includes("articles"), "应生成 articles 别名指向 articlesIndex");
  });

  it("什么都不缺时，返回空计划", () => {
    const renderer = "articlesIndex.forEach(a => console.log(a));";
    const dataFile = 'const articlesIndex = [{"id":"1"}];';
    const plan = planRendererVarBridge(
      [{ content: renderer }],
      [{ content: dataFile }, { content: renderer }],
      "articlesIndex",
      CANDIDATES,
    );
    assert.equal(plan.aliases.length, 0);
    assert.equal(plan.stubs.size, 0);
  });
});
