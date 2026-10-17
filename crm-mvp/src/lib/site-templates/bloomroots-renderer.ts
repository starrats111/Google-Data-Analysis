/**
 * D-370：bloomroots.top 的渲染器（重写，不是抄）
 *
 * 背景：该站首页加载 js/articles-index.js + script.js，两个都是纯数据
 * （script.js 是 `const articlesData = [...]`），残存的 427KB 里
 * innerHTML / getElementById / querySelector / function 全部 0 次 ——
 * 渲染器整段在被截断的尾部，源码彻底丢了，首页也没有内联脚本。
 *
 * 为什么不是从 aurislane.top 桥接（01 原本批准的办法）：
 * 查证后那条路走不通。aurislane 的 script.js 里确实有写 #articlesGrid 的
 * displayArticles()，容器名和 bloomroots 一致，但它生成的链接是
 * `article-detail.html?id=...` —— 那个页面在 aurislane 上存在（200），
 * 在 bloomroots 上是 **404**。bloomroots 的文章页是 `post-{slug}/` 形态
 * （实测 200），链接规则完全不同。照抄过去首页会有内容，但每篇都点不开。
 *
 * 所以改成按 bloomroots 自己的数据重写一个：
 *   - 容器：#articlesGrid（卡片）、#pagination（分页），与该站首页现有 id 一致
 *   - 链接：读条目自己的 detailUrl（1037 条全都有，实测文章页 200）
 *   - 字段：用 CRM 写的那套（dateLabel / readTime / heroImage / excerpt / category）
 *
 * 数据变量名：该站的 articles-index.js 声明 articlesIndex，script.js 声明
 * articlesData。渲染器两个都认，谁在用谁（见 resolveDataArray）。
 */

/** 每页卡片数，与站群其它站保持一致 */
const PER_PAGE = 6;

/**
 * 生成 bloomroots.top 的渲染器脚本（只含渲染器，不含数据）。
 *
 * 单独成文件写到 `js/renderer.js`，不塞进数据文件 —— 这是 D-370 的教训：
 * 数据和渲染器同住一个文件，任何一次写入没写完丢的都是渲染器。
 * 分开之后，数据文件再被截断也只是列表变少，首页不会整页白掉。
 */
export function buildBloomrootsRenderer(): string {
  return `// bloomroots.top 首页渲染器
// D-370：原渲染器随数据文件截断一起丢了（残存部分一处渲染代码都没有）。
// 这是按该站自己的数据与容器重写的版本，**独立成文件**，不与数据同住 ——
// 数据文件再被截断也只是列表变少，不会整页白屏。
(function () {
  var PER_PAGE = ${PER_PAGE};

  // 该站有两份数据文件：articles-index.js 声明 articlesIndex、
  // script.js 声明 articlesData。谁在用谁，都没有就空列表。
  function resolveDataArray() {
    var candidates = [
      typeof articlesIndex !== "undefined" ? articlesIndex : null,
      typeof articlesData !== "undefined" ? articlesData : null,
      typeof articles !== "undefined" ? articles : null,
      typeof posts !== "undefined" ? posts : null
    ];
    for (var i = 0; i < candidates.length; i++) {
      if (Array.isArray(candidates[i]) && candidates[i].length) return candidates[i];
    }
    return [];
  }

  function esc(s) {
    return String(s == null ? "" : s)
      .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  function hrefOf(p) {
    var raw = p.detailUrl || (p.slug ? "post-" + p.slug : "");
    if (!raw) return "#";
    var clean = String(raw).replace(/^\\/+/, "");
    return clean.indexOf("?") >= 0 ? "/" + clean : "/" + clean.replace(/\\/$/, "") + "/";
  }

  function labelOf(p) {
    var raw = String(p.category || "").trim();
    if (!raw) return "General";
    return raw.replace(/[-_]+/g, " ").replace(/\\b\\w/g, function (m) { return m.toUpperCase(); });
  }

  // D-370：script.js 不只被首页用，category.html?cat=xxx 也加载它
  // （该站首页/分类页共用同一份脚本）。原渲染器丢的时候这段分类过滤
  // 逻辑也一起丢了，没补上的话分类页会把全部分类混在一起展示，
  // 标题也停在模板默认的占位字 "Category" / "Explore our articles" ——
  // 实测现象正是这样。
  function currentCategory() {
    var qs = (window.location && window.location.search) || "";
    var m = /[?&]cat=([^&]+)/.exec(qs);
    return m ? decodeURIComponent(m[1]).trim().toLowerCase() : "";
  }

  var ALL = resolveDataArray().slice();
  var cat = currentCategory();
  if (cat) {
    ALL = ALL.filter(function (p) {
      return String(p.category || "").trim().toLowerCase() === cat;
    });
  }
  ALL.sort(function (a, b) {
    return String(b.dateISO || b.date || "").localeCompare(String(a.dateISO || a.date || ""));
  });

  if (cat) {
    var titleEl = document.getElementById("categoryTitle");
    var subEl = document.getElementById("categorySubtitle");
    if (titleEl) titleEl.innerHTML = esc(labelOf({ category: cat }));
    if (subEl) subEl.innerHTML = ALL.length
      ? "Explore our " + esc(labelOf({ category: cat })) + " articles"
      : "No articles in this category yet";
  }

  var page = 1;

  function render() {
    var grid = document.getElementById("articlesGrid");
    if (!grid) return;

    var pages = Math.max(1, Math.ceil(ALL.length / PER_PAGE));
    if (page > pages) page = pages;
    if (page < 1) page = 1;

    var slice = ALL.slice((page - 1) * PER_PAGE, page * PER_PAGE);

    if (slice.length === 0) {
      grid.innerHTML = '<p class="br-empty">No articles yet.</p>';
    } else {
      grid.innerHTML = slice.map(function (p) {
        var img = p.heroImage || p.image || "";
        return '<article class="article-card">' +
          '<a class="article-card-img" href="' + esc(hrefOf(p)) + '">' +
            (img
              ? '<img src="' + esc(img) + '" alt="' + esc(p.title) + '" loading="lazy" />'
              : '<span class="article-card-ph"></span>') +
          '</a>' +
          '<div class="article-card-body">' +
            '<span class="article-card-cat">' + esc(labelOf(p)) + '</span>' +
            '<h3 class="article-card-title"><a href="' + esc(hrefOf(p)) + '">' +
              esc(p.title) + '</a></h3>' +
            (p.excerpt ? '<p class="article-card-excerpt">' + esc(p.excerpt) + '</p>' : '') +
            '<div class="article-card-meta">' +
              esc(p.dateLabel || p.date || "") +
              (p.readTime ? ' · ' + esc(p.readTime) : '') +
            '</div>' +
          '</div>' +
        '</article>';
      }).join("");
    }

    var pg = document.getElementById("pagination");
    if (!pg) return;
    if (pages <= 1) { pg.innerHTML = ""; return; }

    var html = '<button class="br-pg" data-p="' + (page - 1) + '"' +
      (page <= 1 ? " disabled" : "") + '>Prev</button>';
    for (var i = 1; i <= pages; i++) {
      html += '<button class="br-pg' + (i === page ? " active" : "") +
        '" data-p="' + i + '">' + i + "</button>";
    }
    html += '<button class="br-pg" data-p="' + (page + 1) + '"' +
      (page >= pages ? " disabled" : "") + '>Next</button>';
    pg.innerHTML = html;

    var btns = pg.querySelectorAll("[data-p]");
    for (var k = 0; k < btns.length; k++) {
      btns[k].addEventListener("click", function () {
        var x = parseInt(this.getAttribute("data-p"), 10);
        if (x >= 1 && x <= pages) { page = x; render(); window.scrollTo({ top: 0, behavior: "smooth" }); }
      });
    }
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", render);
  } else {
    render();
  }
})();
`;
}
