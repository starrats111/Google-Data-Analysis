/**
 * D-370：resolveBrokenDataPathFromLoaded 的回归。
 *
 * 实测踩过的坑（vitasphere.top）：该站首页加载 js/articles-index.js（数据）
 * + js/main.js（渲染器），两个文件各自语法都合法、渲染器也确实存在——但渲染器
 * 用到的 `products` / `categoryNames` 全站没有任何文件声明过（声明在站点另一个
 * 从没被首页引用过的 js/data.js 里）。跑起来会 ReferenceError，首页白屏。
 *
 * 旧版判据只认两类损坏（①截断 ②渲染器被整段抹掉），这第三类查不到就返回 null，
 * 调用方兜底落到一个孤儿同名文件（该站确实留着一个没人加载的 assets/js/main.js），
 * 把没人加载的文件改了，首页真正加载的 js/articles-index.js 原封不动，
 * 结果是 apply 报 `repaired_but_blank`——文件是改了，改错了文件。
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { resolveBrokenDataPathFromLoaded } from "../src/lib/site-write-guard";

// vitasphere.top 真实形态的简化版（关键字段/结构保持一致）
const VITASPHERE_DATA = {
  path: "js/articles-index.js",
  content: '// 文章索引\nconst articlesIndex = [\n  {"id":"1","title":"T"}\n];\n'
    + "const blogArticles = articlesIndex;\n",
};
const VITASPHERE_RENDERER = {
  path: "js/main.js",
  content: `
let currentPage = 1;
function displayProducts(category = null) {
  const productGrid = document.querySelector('.product-grid');
  if (!productGrid) return;
  let filteredProducts = products;
  if (filteredProducts.length === 0) {
    productGrid.innerHTML = '<p>No products found.</p>';
  } else {
    productGrid.innerHTML = filteredProducts.map(product => {
      const categoryName = categoryNames[product.category] || product.category;
      return '<div>' + categoryName + '</div>';
    }).join('');
  }
}
document.addEventListener('DOMContentLoaded', function () { displayProducts(); });
`,
};
// 孤儿文件：没人加载，但语法完好、也含渲染代码（真实踩过的 assets/js/main.js 形态）
const ORPHAN_RENDERER = {
  path: "assets/js/main.js",
  content: "var posts = []; function sync(){ var grid=document.getElementById('article-list'); "
    + "if(grid) grid.innerHTML = posts.map(p=>p.title).join(''); } sync();",
};

describe("D-370 resolveBrokenDataPathFromLoaded", () => {
  it("截断类：返回那个语法不过的文件", () => {
    const broken = { path: "js/main.js", content: "function f( {" };
    const good = { path: "js/data.js", content: "const posts = [];" };
    assert.equal(resolveBrokenDataPathFromLoaded([good, broken]), "js/main.js");
  });

  it("渲染器被抹类：全部脚本都没渲染代码，返回数据文件", () => {
    const dataOnly1 = { path: "js/data.js", content: "const posts = [{\"id\":\"1\"}];" };
    const dataOnly2 = { path: "js/extra.js", content: "const tags = ['a'];" };
    assert.equal(resolveBrokenDataPathFromLoaded([dataOnly1, dataOnly2]), "js/data.js");
  });

  it("vitasphere 形态：运行时缺失全局，返回数据文件而不是渲染器文件", () => {
    const result = resolveBrokenDataPathFromLoaded([VITASPHERE_DATA, VITASPHERE_RENDERER]);
    assert.equal(result, "js/articles-index.js",
      "应返回数据文件 js/articles-index.js，让后续在它末尾补全局空壳");
  });

  it("vitasphere 形态 + 孤儿文件：绝不能把孤儿文件错当成目标", () => {
    // 这是实测踩过的真实坑：孤儿文件语法完好、也含渲染代码，顺序排在前面时
    // 旧逻辑完全不检查它，但新逻辑也不该因为它「看起来正常」就选中它。
    const result = resolveBrokenDataPathFromLoaded([ORPHAN_RENDERER, VITASPHERE_DATA, VITASPHERE_RENDERER]);
    assert.notEqual(result, "assets/js/main.js", "孤儿文件不该被选中");
    assert.equal(result, "js/articles-index.js", "应该定位到真正在用的数据文件");
  });

  it("一切正常时返回 null（不该乱动好站）", () => {
    const data = { path: "js/data.js", content: "const posts = [{\"id\":\"1\"}];" };
    const renderer = {
      path: "js/main.js",
      content: "var grid=document.getElementById('g'); grid.innerHTML = posts.map(p=>p.id).join('');",
    };
    assert.equal(resolveBrokenDataPathFromLoaded([data, renderer]), null);
  });

  it("空列表返回 null", () => {
    assert.equal(resolveBrokenDataPathFromLoaded([]), null);
  });

  it("quiblo 形态：同样是运行时缺失全局（featuredProducts），返回数据文件", () => {
    const data = { path: "js/articles-index.js", content: "const articlesIndex = [{\"id\":\"1\"}];" };
    const renderer = {
      path: "script.js",
      content: `
function displayFeaturedProducts() {
  const el = document.getElementById('featuredProducts');
  if (!el) return;
  if (!featuredProducts || featuredProducts.length === 0) {
    el.innerHTML = '<div>No featured products</div>';
    return;
  }
  el.innerHTML = featuredProducts.map(p => p.name).join('');
}
document.addEventListener('DOMContentLoaded', displayFeaturedProducts);
`,
    };
    assert.equal(resolveBrokenDataPathFromLoaded([data, renderer]), "js/articles-index.js");
  });
});
