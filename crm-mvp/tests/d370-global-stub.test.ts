/**
 * D-370：findMissingGlobalsWithKind 的回归，拿 vitasphere.top / quiblo.top 的
 * 真实渲染器片段（照抄关键部分）验证。
 *
 * 背景：这两个站的渲染器要用的 products/categoryNames/featuredProducts/blogPosts
 * 声明在站点另一个数据文件里（js/data.js），但首页压根没引用那个文件。01 的决定：
 * 不引入那份演示数据，渲染器缺的全局补成空壳（数组用 []，查表用 {}）——两站的
 * 渲染代码对空值都有专门的「没有内容」兜底文案，不会崩。
 *
 * 这个检测踩过三个坑，都在这里锁住：
 *   ① 形参不能当「全文件已声明」的证据：`function renderProducts(products){}`
 *      会让另一个函数里 `let filteredProducts = products;` 的真实缺失被掩盖。
 *   ② 嵌套括号的箭头函数形参会被正则吞掉左括号（`((entries) => {` 捕获组变成
 *      `"(entries"`），导致形参名误判成缺失全局。
 *   ③ 属性访问（`product.reviews.map(...)`）里的属性名不是全局变量，
 *      不能被 `\.map(` 这类正则误抓。
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { runInNewContext } from "node:vm";
import { findMissingGlobalsWithKind, looksLikeRenderer } from "../src/lib/site-write-guard";

// vitasphere.top js/main.js 的关键片段（照抄形态，字段名一致）
const VITASPHERE_RENDERER = `
let currentPage = 1;
function displayProducts(category = null) {
  const productGrid = document.querySelector('.product-grid');
  if (!productGrid) return;
  let filteredProducts = products;
  if (category) {
    filteredProducts = products.filter(product => product.category === category);
  }
  if (filteredProducts.length === 0) {
    productGrid.innerHTML = '<p>No products found.</p>';
  } else {
    productGrid.innerHTML = filteredProducts.map(product => {
      const categoryName = categoryNames[product.category] || product.category;
      return '<div>' + categoryName + '</div>';
    }).join('');
  }
}
// 这个函数把 products 声明成形参——不能让它掩盖上面那个真实的模块级缺失
function renderProducts(products) {
  const container = document.getElementById('products-container');
  if (!container) return;
  container.innerHTML = products.map(p => p.name).join('');
}
document.addEventListener('DOMContentLoaded', function () { displayProducts(); });
`;

// quiblo.top script.js 的关键片段
const QUIBLO_RENDERER = `
function displayFeaturedProducts() {
  const el = document.getElementById('featuredProducts');
  if (!el) return;
  if (!featuredProducts || featuredProducts.length === 0) {
    el.innerHTML = '<div>No featured products</div>';
    return;
  }
  el.innerHTML = featuredProducts.map(product => {
    return '<div>' + product.reviews.map(review => review.text).join('') + '</div>';
  }).join('');
}
const observer = new IntersectionObserver((entries) => {
  entries.forEach(entry => { entry.target.classList.add('visible'); });
});
document.addEventListener('DOMContentLoaded', function () { displayFeaturedProducts(); });
`;

function makeStubbedScript(declaredVar: string, stubs: Map<string, "array" | "object">): string {
  const lines: string[] = [`var ${declaredVar} = [];`];
  for (const [n, kind] of stubs) lines.push(`var ${n} = ${kind === "array" ? "[]" : "{}"};`);
  return lines.join("\n");
}

describe("D-370 findMissingGlobalsWithKind", () => {
  it("vitasphere 形态：找出 products(数组) 和 categoryNames(对象)，形参不掩盖真缺失", () => {
    const stubs = findMissingGlobalsWithKind(
      [{ content: VITASPHERE_RENDERER }],
      [{ content: VITASPHERE_RENDERER }],
      new Set(["articlesIndex"]),
    );
    assert.equal(stubs.get("products"), "array");
    assert.equal(stubs.get("categoryNames"), "object");
  });

  it("quiblo 形态：找出 featuredProducts，属性访问 reviews 不被误报", () => {
    const stubs = findMissingGlobalsWithKind(
      [{ content: QUIBLO_RENDERER }],
      [{ content: QUIBLO_RENDERER }],
      new Set(["articlesIndex"]),
    );
    assert.equal(stubs.get("featuredProducts"), "array");
    assert.equal(stubs.has("reviews"), false, "product.reviews 是属性访问，不是全局");
  });

  it("即便 entries 被误判成缺失全局，补的空壳也不影响实际运行（箭头函数参数遮蔽外层）", () => {
    // 这是已知的可接受误报：(entries) => {...} 的形参会在函数体内完全遮蔽
    // 外层同名变量，补一行 `var entries = []` 是条无害的死代码，不会让
    // IntersectionObserver 的回调拿到空数组 —— 真的跑一遍证实这一点。
    const stubs = findMissingGlobalsWithKind(
      [{ content: QUIBLO_RENDERER }],
      [{ content: QUIBLO_RENDERER }],
      new Set(["articlesIndex"]),
    );
    const prefix = makeStubbedScript("articlesIndex", stubs);
    const calls: unknown[] = [];
    const sandbox = {
      IntersectionObserver: class {
        constructor(cb: (entries: unknown[]) => void) {
          // 模拟真实回调：传入非空数组，验证形参没被外层的空壳 entries 顶掉
          cb([{ target: { classList: { add: (c: string) => calls.push(c) } } }]);
        }
      },
      document: { addEventListener: () => {}, getElementById: () => null },
    };
    runInNewContext(prefix + "\n" + QUIBLO_RENDERER, sandbox);
    assert.deepEqual(calls, ["visible"], "回调里的 entries 必须是形参那个，不受外层空壳影响");
  });

  it("两段渲染器都仍判定为「渲染器」", () => {
    assert.equal(looksLikeRenderer(VITASPHERE_RENDERER), true);
    assert.equal(looksLikeRenderer(QUIBLO_RENDERER), true);
  });
});
