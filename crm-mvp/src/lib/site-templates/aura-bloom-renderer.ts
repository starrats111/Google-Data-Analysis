/**
 * D-370：aura-bloom.top 的渲染器（重写，不是抄 A1）
 *
 * 背景：该站首页布局（#categoryChips 分类按钮、#searchInput 搜索框、
 * #resultsCount/#resultsMeta 结果计数、#postsGrid 卡片网格、#pagination
 * 分页）是站点自带的，从未由 CRM 生成，和 A1 模板假定的那套容器
 * （secKicker/secTitle/catbar/headerNav/mostRead/lead/leadWrap/empty）
 * 完全不是一回事。
 *
 * 实测踩的坑：先把容器名从 article-list 改成 postsGrid（D-370 另一个
 * PR 修的），确实让脚本开始往对的容器写了，但 A1 模板里一堆其它容器
 * （secKicker 等）在这个站上不存在、且没有空值保护，脚本跑两步就因
 * `null.textContent=...` 报 TypeError 整个中断——换容器名treat不了根本
 * 问题，这个站需要专属渲染器，而不是修 A1 模板的某个 id。
 *
 * 分类映射：首页按钮用 data-category="Fashion & Accessories" 这种人类
 * 可读长名，CRM 数据用 "fashion" 这种小写短 key，渲染器里做映射。
 */

const CATEGORY_LABELS: Record<string, string> = {
  fashion: "Fashion & Accessories",
  health: "Health & Beauty",
  beauty: "Health & Beauty",
  home: "Home & Garden",
  travel: "Travel & Stays",
  finance: "Finance & Insurance",
  food: "Food & Beverage",
  "marketing & business": "Marketing & Business",
  marketing: "Marketing & Business",
};

const PER_PAGE = 9;

/** 生成 aura-bloom.top 的渲染器脚本（只含渲染器，不含数据，独立成文件写法同 bloomroots.top） */
export function buildAuraBloomRenderer(): string {
  return `// aura-bloom.top 首页渲染器
// D-370：原渲染器（A1 模板那套）和该站首页实际容器完全不符，重写专有渲染器。
(function () {
  var PER_PAGE = ${PER_PAGE};
  var CATEGORY_LABELS = ${JSON.stringify(CATEGORY_LABELS)};

  function resolveDataArray() {
    var candidates = [
      typeof posts !== "undefined" ? posts : null,
      typeof articlesIndex !== "undefined" ? articlesIndex : null,
      typeof articlesData !== "undefined" ? articlesData : null
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
    var grid = document.getElementById("postsGrid");
    if (!grid) return;
    var list = filtered();

    var countEl = document.getElementById("resultsCount");
    if (countEl) countEl.textContent = String(list.length);

    var pages = Math.max(1, Math.ceil(list.length / PER_PAGE));
    if (page > pages) page = pages;
    if (page < 1) page = 1;
    var slice = list.slice((page - 1) * PER_PAGE, page * PER_PAGE);

    if (slice.length === 0) {
      grid.innerHTML = '<p class="ab-empty">No stories found.</p>';
    } else {
      grid.innerHTML = slice.map(function (p) {
        var img = p.heroImage || p.image || "";
        return '<article class="ab-post-card">' +
          '<a class="ab-post-card-img" href="' + esc(hrefOf(p)) + '">' +
            (img
              ? '<img src="' + esc(img) + '" alt="' + esc(p.title) + '" loading="lazy" />'
              : '<span class="ab-post-card-ph"></span>') +
          '</a>' +
          '<div class="ab-post-card-body">' +
            '<span class="ab-post-card-cat">' + esc(labelOf(p.category)) + '</span>' +
            '<h3 class="ab-post-card-title"><a href="' + esc(hrefOf(p)) + '">' +
              esc(p.title) + '</a></h3>' +
            (p.excerpt ? '<p class="ab-post-card-excerpt">' + esc(p.excerpt) + '</p>' : '') +
            '<div class="ab-post-card-meta">' +
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
        var html = '<button class="ab-pg" data-p="' + (page - 1) + '"' +
          (page <= 1 ? " disabled" : "") + '>Prev</button>';
        for (var i = 1; i <= pages; i++) {
          html += '<button class="ab-pg' + (i === page ? " active" : "") +
            '" data-p="' + i + '">' + i + "</button>";
        }
        html += '<button class="ab-pg" data-p="' + (page + 1) + '"' +
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
        for (var j = 0; j < chips.length; j++) chips[j].classList.remove("is-active");
        this.classList.add("is-active");
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
