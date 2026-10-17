/**
 * D-370：thegoodsandguard.top 的渲染器（重写，不是抄 A1）
 *
 * 同一类坑，第二次踩（第一次是 aura-bloom.top）：容器名从 article-list
 * 改成 articleGrid 之后 apply 实测，脚本确实往对的容器写了，但立刻因
 * TypeError 中断——A1 模板里的 secKicker/secTitle 等辅助容器在这个站上
 * 不存在。查实该站首页布局（#categoryFilters 分类按钮、#searchInput
 * 搜索框、#articleGrid 文章网格、#paginationControls 分页、
 * #homeProductCapsules 产品推荐区——这个和文章列表无关，不处理）是站点
 * 自带的，和 A1 模板完全不是一回事，需要专属渲染器。
 *
 * 分类映射用该站首页按钮的实际措辞（和 aura-bloom.top 不完全一样，
 * 比如这里是 "Travel & Accommodation" 不是 "Travel & Stays"）。
 */

const CATEGORY_LABELS: Record<string, string> = {
  fashion: "Clothing & Accessories",
  health: "Health & Beauty",
  beauty: "Health & Beauty",
  home: "Home & Garden",
  travel: "Travel & Accommodation",
  finance: "Finance & Insurance",
  food: "Food & Beverage",
};

const PER_PAGE = 9;

/** 生成 thegoodsandguard.top 的渲染器脚本（数据+渲染器同住一个文件，A1 架构） */
export function buildTheGoodsAndGuardRenderer(): string {
  return `// thegoodsandguard.top 首页渲染器
// D-370：原渲染器（A1 模板那套）和该站首页实际容器完全不符，重写专有渲染器。
(function () {
  var PER_PAGE = ${PER_PAGE};
  var CATEGORY_LABELS = ${JSON.stringify(CATEGORY_LABELS)};

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

  function render() {
    var grid = document.getElementById("articleGrid");
    if (!grid) return;
    var list = filtered();

    var pages = Math.max(1, Math.ceil(list.length / PER_PAGE));
    if (page > pages) page = pages;
    if (page < 1) page = 1;
    var slice = list.slice((page - 1) * PER_PAGE, page * PER_PAGE);

    if (slice.length === 0) {
      grid.innerHTML = '<p class="tgg-empty">No stories found.</p>';
    } else {
      grid.innerHTML = slice.map(function (p) {
        var img = p.heroImage || p.image || "";
        return '<article class="tgg-post-card">' +
          '<a class="tgg-post-card-img" href="' + esc(hrefOf(p)) + '">' +
            (img
              ? '<img src="' + esc(img) + '" alt="' + esc(p.title) + '" loading="lazy" />'
              : '<span class="tgg-post-card-ph"></span>') +
          '</a>' +
          '<div class="tgg-post-card-body">' +
            '<span class="tgg-post-card-cat">' + esc(labelOf(p.category)) + '</span>' +
            '<h3 class="tgg-post-card-title"><a href="' + esc(hrefOf(p)) + '">' +
              esc(p.title) + '</a></h3>' +
            (p.excerpt ? '<p class="tgg-post-card-excerpt">' + esc(p.excerpt) + '</p>' : '') +
            '<div class="tgg-post-card-meta">' +
              esc(p.dateLabel || p.date || "") +
              (p.readTime ? ' · ' + esc(p.readTime) : '') +
            '</div>' +
          '</div>' +
        '</article>';
      }).join("");
    }

    var pg = document.getElementById("paginationControls");
    if (pg) {
      if (pages <= 1) {
        pg.innerHTML = "";
      } else {
        var html = '<button class="tgg-pg" data-p="' + (page - 1) + '"' +
          (page <= 1 ? " disabled" : "") + '>Prev</button>';
        for (var i = 1; i <= pages; i++) {
          html += '<button class="tgg-pg' + (i === page ? " active" : "") +
            '" data-p="' + i + '">' + i + "</button>";
        }
        html += '<button class="tgg-pg" data-p="' + (page + 1) + '"' +
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

  function bindCategoryChips() {
    var chips = document.querySelectorAll("[data-category]");
    for (var i = 0; i < chips.length; i++) {
      chips[i].addEventListener("click", function () {
        var cat = this.getAttribute("data-category");
        activeCategory = cat === "all" ? "all" : cat;
        page = 1;
        for (var j = 0; j < chips.length; j++) chips[j].classList.remove("active");
        this.classList.add("active");
        render();
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
