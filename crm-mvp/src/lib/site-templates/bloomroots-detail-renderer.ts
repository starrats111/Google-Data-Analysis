/**
 * D-378：bloomroots.top 详情页渲染器。
 *
 * 背景：该站 article.html?title={slug} 的 #articleContent 容器从 D-370
 * 重写以来一直是空的 —— 当时只补了首页列表渲染器（bloomroots-renderer.ts），
 * 没人写"按 URL 参数查数据、填充详情正文"这段代码，详情页天生打不开，
 * 库里文章内容完好，纯粹是没人读它。
 *
 * 独立成文件（js/detail-renderer.js），不与首页渲染器 script.js 同住，
 * 延续 D-370 的教训：数据/渲染器拆开，一个文件坏了不连坐另一个。
 */
export function buildBloomrootsDetailRenderer(): string {
  return `// bloomroots.top 详情页渲染器
// D-378：article.html?title={slug} 的 #articleContent 之前没人填过。
// 按 URL 的 title 参数（实际存的是 slug）在首页索引里查条目，
// 再 fetch 对应的 js/articles/{id}.json 取完整正文填充。
(function () {
  function qs(name) {
    var m = new RegExp("[?&]" + name + "=([^&]+)").exec(window.location.search);
    return m ? decodeURIComponent(m[1].replace(/\\+/g, " ")) : "";
  }

  function esc(s) {
    return String(s == null ? "" : s)
      .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  }

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

  function renderError(container, msg) {
    container.innerHTML = '<p style="padding:40px 0;text-align:center;color:#8a8a8a;">' + esc(msg) + '</p>';
  }

  function renderArticle(container, meta, fullContent) {
    var title = meta.title || "";
    var dateLabel = meta.dateLabel || meta.date || "";
    var content = fullContent || meta.excerpt || "";
    container.innerHTML =
      '<header class="article-head">' +
        '<h1 class="article-title">' + esc(title) + '</h1>' +
        (dateLabel ? '<div class="article-meta">' + esc(dateLabel) + '</div>' : '') +
      '</header>' +
      '<div class="article-content">' + content + '</div>';
    document.title = title ? (title + " - BloomRoots") : document.title;
  }

  function init() {
    var container = document.getElementById("articleContent");
    if (!container) return;

    var slug = qs("title");
    if (!slug) {
      renderError(container, "Article not found.");
      return;
    }

    var all = resolveDataArray();
    var entry = null;
    for (var i = 0; i < all.length; i++) {
      if (String(all[i].slug || "") === slug) { entry = all[i]; break; }
    }

    if (!entry) {
      renderError(container, "Article not found.");
      return;
    }

    if (!entry.id) {
      renderArticle(container, entry, "");
      return;
    }

    fetch("js/articles/" + entry.id + ".json", { cache: "no-store" })
      .then(function (res) { if (!res.ok) throw new Error("not ok"); return res.json(); })
      .then(function (data) {
        renderArticle(container, entry, (data && data.content) || "");
      })
      .catch(function () {
        renderArticle(container, entry, "");
      });
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
`;
}
