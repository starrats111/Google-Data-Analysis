/**
 * D-370：everydaynes.top 的渲染器（重写，不是抄 A1）
 *
 * 同一类坑，第三次踩（第一次 aura-bloom.top，第二次 thegoodsandguard.top）：
 * 容器名改对（article-list → articleGrid）之后 apply 实测，脚本因 A1
 * 模板里一堆不存在的辅助容器直接 TypeError 中断。该站首页结构
 * （顶部 nav 的 data-category 筛选按钮、#categoryTags 空容器由渲染器
 * 自己填充分类标签、#articleGrid 文章网格、#pagination 分页）和前两站
 * 又不一样，各站都是独立模板，不能共用。
 *
 * 库里该站文章的 category 字段混进了两种格式（历史脏数据，不是这次要
 * 修的范围）：标准短 key（travel/lifestyle）和已经是长名小写版本
 * （travel & stay/health & beauty）。labelOf 两种都认。
 */

const CATEGORY_LABELS: Record<string, string> = {
  fashion: "Clothing & Accessories",
  "clothing & accessories": "Clothing & Accessories",
  health: "Health & Beauty",
  beauty: "Health & Beauty",
  "health & beauty": "Health & Beauty",
  home: "Home & Garden",
  "home & garden": "Home & Garden",
  travel: "Travel & Stay",
  "travel & stay": "Travel & Stay",
  finance: "Finance & Insurance",
  "finance & insurance": "Finance & Insurance",
  food: "Food & Beverage",
  "food & beverage": "Food & Beverage",
};

const PER_PAGE = 9;

/** 生成 everydaynes.top 的渲染器脚本（数据+渲染器同住一个文件，A1 架构） */
export function buildEverydaynesRenderer(): string {
  return `// everydaynes.top 首页渲染器
// D-370：原渲染器（A1 模板那套）和该站首页实际容器完全不符，重写专有渲染器。
(function () {
  var PER_PAGE = ${PER_PAGE};
  var CATEGORY_LABELS = ${JSON.stringify(CATEGORY_LABELS)};
  var CATEGORY_ORDER = ["Clothing & Accessories", "Health & Beauty", "Home & Garden", "Travel & Stay", "Finance & Insurance", "Food & Beverage"];

  function resolveDataArray() {
    var candidates = [
      typeof posts !== "undefined" ? posts : null,
      typeof articlesIndex !== "undefined" ? articlesIndex : null
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

  // 库里该站 category 混进两种格式（短 key / 已经是长名小写），两种都认
  function labelOf(catKey) {
    var k = String(catKey || "").trim().toLowerCase();
    if (!k) return "General";
    return CATEGORY_LABELS[k] || (k.charAt(0).toUpperCase() + k.slice(1));
  }

  var ALL = resolveDataArray().slice();
  ALL.sort(function (a, b) {
    return String(b.dateISO || b.date || "").localeCompare(String(a.dateISO || a.date || ""));
  });

  var activeCategory = "all";
  var query = "";
  var page = 1;

  function filtered() {
    var list = ALL;
    if (activeCategory !== "all") {
      list = list.filter(function (p) { return labelOf(p.category) === activeCategory; });
    }
    if (query) {
      var q = query.toLowerCase();
      list = list.filter(function (p) {
        return String(p.title || "").toLowerCase().indexOf(q) >= 0
          || String(p.excerpt || "").toLowerCase().indexOf(q) >= 0;
      });
    }
    return list;
  }

  function setActiveChip(chips, cat) {
    for (var j = 0; j < chips.length; j++) {
      var c = chips[j].getAttribute("data-category");
      if (c === cat) chips[j].classList.add("active"); else chips[j].classList.remove("active");
    }
  }

  function selectCategory(cat) {
    activeCategory = cat === "all" ? "all" : cat;
    page = 1;
    var navChips = document.querySelectorAll("[data-category]");
    setActiveChip(navChips, activeCategory);
    render();
  }

  function render() {
    var grid = document.getElementById("articleGrid");
    if (!grid) return;
    var list = filtered();

    var pages = Math.max(1, Math.ceil(list.length / PER_PAGE));
    if (page > pages) page = pages;
    if (page < 1) page = 1;
    var slice = list.slice((page - 1) * PER_PAGE, page * PER_PAGE);

    if (slice.length === 0) {
      grid.innerHTML = '<p class="ed-empty">No articles found.</p>';
    } else {
      grid.innerHTML = slice.map(function (p) {
        var img = p.heroImage || p.image || "";
        return '<article class="ed-post-card">' +
          '<a class="ed-post-card-img" href="' + esc(hrefOf(p)) + '">' +
            (img
              ? '<img src="' + esc(img) + '" alt="' + esc(p.title) + '" loading="lazy" />'
              : '<span class="ed-post-card-ph"></span>') +
          '</a>' +
          '<div class="ed-post-card-body">' +
            '<span class="ed-post-card-cat">' + esc(labelOf(p.category)) + '</span>' +
            '<h3 class="ed-post-card-title"><a href="' + esc(hrefOf(p)) + '">' +
              esc(p.title) + '</a></h3>' +
            (p.excerpt ? '<p class="ed-post-card-excerpt">' + esc(p.excerpt) + '</p>' : '') +
            '<div class="ed-post-card-meta">' +
              esc(p.dateLabel || p.date || "") +
              (p.readTime ? ' · ' + esc(p.readTime) : '') +
            '</div>' +
          '</div>' +
        '</article>';
      }).join("");
    }

    var pg = document.getElementById("pagination");
    if (pg) {
      if (pages <= 1) {
        pg.innerHTML = "";
      } else {
        var html = '<button class="ed-pg" data-p="' + (page - 1) + '"' +
          (page <= 1 ? " disabled" : "") + '>Prev</button>';
        for (var i = 1; i <= pages; i++) {
          html += '<button class="ed-pg' + (i === page ? " active" : "") +
            '" data-p="' + i + '">' + i + "</button>";
        }
        html += '<button class="ed-pg" data-p="' + (page + 1) + '"' +
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
    }
  }

  function renderCategoryTags() {
    var tags = document.getElementById("categoryTags");
    if (!tags) return;
    var html = '<button class="ed-tag active" data-category="all">All</button>';
    for (var i = 0; i < CATEGORY_ORDER.length; i++) {
      html += '<button class="ed-tag" data-category="' + esc(CATEGORY_ORDER[i]) + '">' + esc(CATEGORY_ORDER[i]) + '</button>';
    }
    tags.innerHTML = html;
  }

  function bindCategoryChips() {
    var chips = document.querySelectorAll("[data-category]");
    for (var i = 0; i < chips.length; i++) {
      chips[i].addEventListener("click", function () {
        selectCategory(this.getAttribute("data-category"));
      });
    }
  }

  function bindSearch() {
    var input = document.getElementById("searchInput");
    if (!input) return;
    input.addEventListener("input", function () {
      query = String(input.value || "").trim();
      page = 1;
      render();
    });
  }

  function init() {
    renderCategoryTags();
    bindCategoryChips();
    bindSearch();
    render();
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
`;
}
