/**
 * D-370：novanest.one 的渲染器（抢救 + 补全 + 改读 CRM 字段名）
 *
 * 背景：该站的 `scripts.js` 装着「数据 + 渲染器」，被截断后渲染器断在
 * `prevBtn.disabled = ` 这一句中间，首页白屏。没有 .bak、没有备份目录、没有 .git，
 * 也没有同模板的别的站可抄 —— 但渲染器主体（2,491 字节、两个函数）还在文件里，
 * 所以把它抄出来补全，是比「整站改造成 A1」改动小得多的办法（01 选的方案 1）。
 *
 * 抢救出来的部分（逐字保留，只改字段名）：
 *   - POSTS_PER_PAGE = 3
 *   - normalizeText()
 *   - renderPosts()：读 #categoryFilter / #searchInput 做筛选，
 *     往 #postsContainer 写卡片，再更新 #pageInfo / #prevPage / #nextPage
 *
 * 补全的部分（原文件截断处之后，按首页现有控件推定）：
 *   - prevBtn/nextBtn 的 disabled 状态与点击翻页
 *   - 筛选框/搜索框的事件绑定
 *   - #quickCategories 的分类快捷入口
 *   - 首次渲染调用
 *
 * **字段名改写**（这是关键）：CRM 的发布早已把该站的原生数据格式覆盖成自己那套，
 * 现有数据里只有 dateLabel / readTime / detailUrl，而原渲染器读的是
 * displayDate / readingTime / detailPage。11 个字段里缺 5 个，
 * 不改字段名的话卡片上会是一片 undefined。对应关系：
 *   displayDate      → dateLabel（回退 date）
 *   readingTime      → readTime
 *   detailPage       → detailUrl（CRM 写的是不带前导斜杠的相对路径）
 *   categoryLabel    → 由 category 首字母大写现算（CRM 不写这个字段）
 *   productHighlight → **去掉**（CRM 没有「产品精选」这个概念）
 *   productPage      → **去掉**（同上，连带去掉「View product picks」那个按钮）
 * 01 已确认：去掉产品精选入口可以。
 */

/** 卡片要用的字段，CRM 的索引条目里都有 */
export const NOVANEST_REQUIRED_FIELDS = [
  "title", "excerpt", "category", "dateLabel", "readTime", "detailUrl", "heroImage",
] as const;

/**
 * 生成 novanest.one 的 scripts.js 全文（数据 + 渲染器）。
 * @param postsJson 已序列化的条目数组（含前后方括号）
 */
export function buildNovanestScriptsJs(postsJson: string): string {
  return `const POSTS = ${postsJson};

const POSTS_PER_PAGE = 3;

function normalizeText(text) {
  return String(text == null ? "" : text).toLowerCase();
}

// D-370：CRM 的索引条目没有 categoryLabel，用 category 现算一个展示名
function categoryLabelOf(post) {
  const raw = String(post.category || "").trim();
  if (!raw) return "General";
  return raw.replace(/[-_]+/g, " ").replace(/\\b\\w/g, (m) => m.toUpperCase());
}

// D-370：原渲染器读 displayDate / readingTime / detailPage，
// CRM 写的是 dateLabel / readTime / detailUrl —— 这里做兼容取值，
// 两套字段名都认，谁在就用谁，避免将来任一侧改名又白屏。
function displayDateOf(post) {
  return post.dateLabel || post.displayDate || post.date || "";
}
function readingTimeOf(post) {
  return post.readTime || post.readingTime || "";
}
function detailHrefOf(post) {
  const raw = post.detailUrl || post.detailPage || (post.slug ? "post-" + post.slug : "");
  if (!raw) return "#";
  const clean = String(raw).replace(/^\\/+/, "");
  return clean.indexOf("?") >= 0 ? "/" + clean : "/" + clean.replace(/\\/$/, "") + "/";
}
function imageOf(post) {
  return post.heroImage || post.image || "";
}
function escapeHtml(s) {
  return String(s == null ? "" : s)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

var currentRenderedPage = 1;

// ↓↓↓ 以下 renderPosts 主体抄自该站残存的 scripts.js，只改了字段取值 ↓↓↓
function renderPosts(page) {
  page = page || 1;
  const container = document.getElementById("postsContainer");
  if (!container) return;

  const catEl = document.getElementById("categoryFilter");
  const category = catEl ? catEl.value : "";
  const searchEl = document.getElementById("searchInput");
  const query = normalizeText(searchEl ? searchEl.value : "");

  let filtered = POSTS;
  if (category && category !== "all") {
    filtered = filtered.filter((p) => p.category === category);
  }
  if (query) {
    filtered = filtered.filter((p) => {
      // 原文还拼了 productHighlight，CRM 没这个字段，去掉
      const haystack = normalizeText(
        p.title + " " + p.excerpt + " " + ((p.tags || []).join(" "))
      );
      return haystack.indexOf(query) >= 0;
    });
  }

  const totalPages = Math.max(1, Math.ceil(filtered.length / POSTS_PER_PAGE));
  const currentPage = Math.min(Math.max(page, 1), totalPages);
  currentRenderedPage = currentPage;

  const start = (currentPage - 1) * POSTS_PER_PAGE;
  const currentSlice = filtered.slice(start, start + POSTS_PER_PAGE);

  container.innerHTML = "";
  currentSlice.forEach((post) => {
    const card = document.createElement("article");
    card.className = "nv-card nv-fade-in";
    const img = imageOf(post);
    card.innerHTML =
      '<div>' +
        '<div class="nv-card-header">' +
          '<span class="nv-tag">' + escapeHtml(categoryLabelOf(post)) + '</span>' +
          '<span class="nv-date">' + escapeHtml(displayDateOf(post)) + '</span>' +
        '</div>' +
        '<h2 class="nv-card-title">' + escapeHtml(post.title) + '</h2>' +
        '<div class="nv-card-meta"><span>' + escapeHtml(readingTimeOf(post)) + '</span></div>' +
        '<p class="nv-card-desc">' + escapeHtml(post.excerpt) + '</p>' +
        '<div class="nv-card-cta">' +
          '<a class="nv-link" href="' + escapeHtml(detailHrefOf(post)) + '">Read article</a>' +
        '</div>' +
      '</div>' +
      '<div class="nv-card-thumb">' +
        (img
          ? '<img src="' + escapeHtml(img) + '" alt="' + escapeHtml(post.title) + '" loading="lazy" />'
          : '<span class="nv-card-thumb-ph"></span>') +
        '<div class="nv-card-thumb-overlay"></div>' +
      '</div>';
    container.appendChild(card);
  });

  const pageInfo = document.getElementById("pageInfo");
  const prevBtn = document.getElementById("prevPage");
  const nextBtn = document.getElementById("nextPage");

  if (pageInfo) {
    pageInfo.textContent = currentPage + " / " + totalPages;
  }
  // ↑↑↑ 残存部分到此为止：原文件断在下面这行的赋值号后面 ↑↑↑
  if (prevBtn && nextBtn) {
    prevBtn.disabled = currentPage <= 1;
    nextBtn.disabled = currentPage >= totalPages;
  }
}

// ── 以下为补全部分（按首页现有控件推定）────────────────────────────────
(function initNovanest() {
  function onReady(fn) {
    if (document.readyState === "loading") {
      document.addEventListener("DOMContentLoaded", fn);
    } else {
      fn();
    }
  }

  onReady(function () {
    const prevBtn = document.getElementById("prevPage");
    const nextBtn = document.getElementById("nextPage");
    if (prevBtn) prevBtn.addEventListener("click", function () { renderPosts(currentRenderedPage - 1); });
    if (nextBtn) nextBtn.addEventListener("click", function () { renderPosts(currentRenderedPage + 1); });

    const catEl = document.getElementById("categoryFilter");
    if (catEl) catEl.addEventListener("change", function () { renderPosts(1); });

    const searchEl = document.getElementById("searchInput");
    if (searchEl) searchEl.addEventListener("input", function () { renderPosts(1); });

    // #quickCategories：按数据里实际出现的分类生成快捷入口
    const quick = document.getElementById("quickCategories");
    if (quick) {
      const seen = [];
      POSTS.forEach(function (p) {
        const c = String(p.category || "").trim();
        if (c && seen.indexOf(c) < 0) seen.push(c);
      });
      if (seen.length) {
        quick.innerHTML = '<button class="nv-chip" data-cat="all">All</button>' +
          seen.map(function (c) {
            return '<button class="nv-chip" data-cat="' + escapeHtml(c) + '">' +
              escapeHtml(categoryLabelOf({ category: c })) + '</button>';
          }).join("");
        quick.querySelectorAll("[data-cat]").forEach(function (b) {
          b.addEventListener("click", function () {
            const c = b.getAttribute("data-cat") || "all";
            if (catEl) catEl.value = c === "all" ? "" : c;
            renderPosts(1);
          });
        });
      }
    }

    renderPosts(1);
  });
})();
`;
}
