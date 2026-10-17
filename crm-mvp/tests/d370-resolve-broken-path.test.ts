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

  it("数据文件已被补过空壳（全局看起来都已声明），③不再触发时仍不能兜底到孤儿文件", () => {
    // 这是实测连续踩过两次的坑：第一次孤儿文件 bug 修好、apply 命中了正确的
    // js/articles-index.js 并补上了 categoryNames={}/products=[]/blogArticles=[]
    // 这几行空壳；下一次再 apply（比如渲染出来还是假数据、需要重修）时，
    // ③规则检查「有没有缺失全局」已经查不出问题了——所有全局都「已声明」，
    // 哪怕声明成了错误的空值。这种情况下不能让函数退回 null，否则调用方会
    // 兜底落到硬编码默认值 "assets/js/main.js"，又把孤儿文件改一遍（实测踩过）。
    const stubbedData = {
      path: "js/articles-index.js",
      content: '// 文章索引\nconst articlesIndex = [\n  {"id":"1","title":"T"}\n];\n'
        + "var blogArticles = [];\nvar products = [];\nvar categoryNames = {};\n",
    };
    const result = resolveBrokenDataPathFromLoaded([ORPHAN_RENDERER, stubbedData, VITASPHERE_RENDERER]);
    assert.notEqual(result, "assets/js/main.js", "不能兜底到孤儿文件");
    assert.equal(result, "js/articles-index.js", "该返回首页实际引用的数据文件");
  });

  it("一切正常时也会返回数据文件路径（这不代表会去改它——见下方说明）", () => {
    // D-370 第④类判据（兜底）：函数现在总是倾向于返回「首页引用的数据文件」，
    // 不再对健康站点返回 null。这不会导致健康站点被误改——
    // 真正「要不要修」由调用方 repairSiteDataFile 里独立的 broken 标志决定
    // （syntax.ok / rendererGone / blankHomepage 三者，不看这个函数的返回值），
    // 这个函数只回答「如果要修，该修哪个文件」。
    //
    // 为什么要改成这样：①②③类规则查的是「代码层面有没有明显毛病」，但
    // vitasphere.top 实测过一种更隐蔽的情况——数据文件已经被某次有缺陷的修复
    // 补过空壳（categoryNames={}、products=[]），全局「看起来」都已声明，
    // ③不再触发，可是首页渲染出来的仍是假数据。那种情况下 verifyHomepageRenders
    // 另外验证会发现问题、判定 broken=true，但如果这个函数在查不出①②③时返回
    // null，调用方就会兜底落到硬编码默认值 "assets/js/main.js"——
    // 猜错了就去改一个首页根本不加载的孤儿文件（实测踩过两次）。
    const data = { path: "js/data.js", content: "const posts = [{\"id\":\"1\"}];" };
    const renderer = {
      path: "js/main.js",
      content: "var grid=document.getElementById('g'); grid.innerHTML = posts.map(p=>p.id).join('');",
    };
    // 返回数据文件路径（证据支撑的猜测），不是 null——但这个健康站点不会被
    // 实际修改：repairSiteDataFile 另外验证首页真的渲染出内容后，broken=false，
    // 根本不会走到用这个路径写文件那一步。
    assert.equal(resolveBrokenDataPathFromLoaded([data, renderer]), "js/data.js");
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

  it("everydaynes.top 形态：唯一一个脚本既是数据又是渲染器，不能返回 null", () => {
    // 实测踩的坑：该站首页只加载 assets/main.js 一个脚本（A1 风格，数据+渲染器
    // 同住一个文件），语法合法、含渲染器代码，①②③全部查不出代码层面的毛病。
    // dataFile 判定逻辑假定「渲染器」和「数据」分开在不同文件，唯一一个文件
    // 既在 renderers 列表里、又不满足 isDataOnly，两条 find 都落空——旧版本
    // 继续返回 null，调用方兜底落到硬编码默认值 "assets/js/main.js"，而该站
    // 实际文件名是 "assets/main.js"，两者不一致，专属渲染器因此从未写入
    // 真正生效的那份文件。
    const onlyScript = {
      path: "assets/main.js",
      content: 'const posts = [\n  {"id":"1","title":"T"}\n];\n'
        + "(function(){ var grid=document.getElementById('articleGrid'); "
        + "if(grid) grid.innerHTML = posts.map(p=>p.title).join(''); })();",
    };
    assert.equal(resolveBrokenDataPathFromLoaded([onlyScript]), "assets/main.js");
  });
});
