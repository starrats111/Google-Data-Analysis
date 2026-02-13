const POSTS = [
  {
    id: "slow-brew-march-2025",
    title: "Slow Brew at Home: Entry-Level Pour-Over Coffee Gear",
    category: "food",
    categoryLabel: "Food & Drinks",
    date: "2025-03-18",
    displayDate: "Mar 18, 2025",
    readingTime: "9 min read",
    excerpt:
      "If you have only known instant coffee, a slow weekend pour-over can feel like a small ritual. We compare flavour, walk through a simple brew routine, and suggest a few beginner-friendly tools to build a home coffee corner.",
    heroImage:
      "https://images.unsplash.com/photo-1495474472287-4d71bcdd2085?auto=format&fit=crop&w=1100&q=80",
    productHighlight: "Hario V60 set / Fellow Stagg EKG kettle",
    detailPage: "post-slow-brew-march-2025.html",
    productPage: "product-coffee-gear.html",
    tags: ["pour-over", "home coffee bar", "gear picks"],
  },
  {
    id: "capsule-wardrobe-may-2025",
    title: "Capsule Wardrobe in Practice: 20 Pieces for a Season of Commuting",
    category: "fashion",
    categoryLabel: "Apparel & Accessories",
    date: "2025-05-09",
    displayDate: "May 9, 2025",
    readingTime: "11 min read",
    excerpt:
      "A full closet but nothing to wear? We build a 20-piece capsule around city commuting, covering cuts, fabrics and colours, then show a concrete week of outfits you can adapt.",
    heroImage:
      "https://images.unsplash.com/photo-1512436991641-6745cdb1723f?auto=format&fit=crop&w=1100&q=80",
    productHighlight: "Crisp white shirts / straight trousers / loafers",
    detailPage: "post-capsule-wardrobe-may-2025.html",
    productPage: "product-capsule-closet.html",
    tags: ["capsule wardrobe", "commute outfits", "minimal style"],
  },
  {
    id: "skin-barrier-july-2025",
    title: "Repair, Don’t Overdo: A Barrier-Friendly Routine for Sensitive Skin",
    category: "health",
    categoryLabel: "Health & Beauty",
    date: "2025-07-02",
    displayDate: "Jul 2, 2025",
    readingTime: "10 min read",
    excerpt:
      "Constantly swapping products and layering actives is often why sensitivity never fully calms down. We unpack a realistic \"subtraction\" routine and share clean, barrier-supportive basics.",
    heroImage:
      "image/头图.png",
    productHighlight: "Gentle cleanser / ceramide cream / low-irritation sunscreen",
    detailPage: "post-skin-barrier-july-2025.html",
    productPage: "product-skin-barrier.html",
    tags: ["sensitive skin", "basic routine", "simple formulas"],
  },
  {
    id: "living-room-sept-2025",
    title: "Living Room Reset: Three Pieces of Furniture for More Breathing Room",
    category: "home",
    categoryLabel: "Home & Garden",
    date: "2025-09-14",
    displayDate: "Sep 14, 2025",
    readingTime: "8 min read",
    excerpt:
      "Instead of adding more decor, we first put the living room on a “diet”. By changing the sofa, coffee table and lighting, the space becomes lighter, easier to maintain, and better for real rest.",
    heroImage:
      "https://images.unsplash.com/photo-1505691938895-1758d7feb511?auto=format&fit=crop&w=1100&q=80",
    productHighlight: "Low-back sofa / light coffee table / layered lighting",
    detailPage: "post-living-room-sept-2025.html",
    productPage: "product-living-room.html",
    tags: ["living room", "soft furnishing", "lighting"],
  },
  {
    id: "finance-oct-2025",
    title: "Building a Calm Money Stack: Tools for Everyday Finance & Insurance",
    category: "finance",
    categoryLabel: "Finance & Insurance",
    date: "2025-10-21",
    displayDate: "Oct 21, 2025",
    readingTime: "12 min",
    excerpt:
      "Instead of chasing every new fintech app, we walk through a quiet, well-structured stack: one spending account, one saving hub, one brokerage, and a simple insurance portfolio you can actually maintain.",
    heroImage:
      "https://images.unsplash.com/photo-1586880244386-8b3e34c8382e?auto=format&fit=crop&w=1100&q=80",
    productHighlight: "No-fee brokerage / high-yield savings / term life & health coverage",
    detailPage: "post-finance-stack-oct-2025.html",
    productPage: "product-finance-stack.html",
    tags: ["personal finance", "insurance basics", "tool stack"],
  },
];

const POSTS_PER_PAGE = 3;

function normalizeText(text) {
  return text.toLowerCase();
}

function renderPosts(page = 1) {
  const container = document.getElementById("postsContainer");
  if (!container) return;

  const category = /** @type {HTMLSelectElement|null} */ (
    document.getElementById("categoryFilter")
  )?.value;
  const query = normalizeText(
    /** @type {HTMLInputElement|null} */ (
      document.getElementById("searchInput")
    )?.value || ""
  );

  let filtered = POSTS;
  if (category && category !== "all") {
    filtered = filtered.filter((p) => p.category === category);
  }
  if (query) {
    filtered = filtered.filter((p) => {
      const haystack = normalizeText(
        `${p.title} ${p.excerpt} ${p.productHighlight} ${(p.tags || []).join(" ")}`
      );
      return haystack.includes(query);
    });
  }

  const totalPages = Math.max(1, Math.ceil(filtered.length / POSTS_PER_PAGE));
  const currentPage = Math.min(Math.max(page, 1), totalPages);

  const start = (currentPage - 1) * POSTS_PER_PAGE;
  const currentSlice = filtered.slice(start, start + POSTS_PER_PAGE);

  container.innerHTML = "";
  currentSlice.forEach((post) => {
    const card = document.createElement("article");
    card.className = "nv-card nv-fade-in";
    card.innerHTML = `
      <div>
        <div class="nv-card-header">
          <span class="nv-tag">${post.categoryLabel}</span>
          <span class="nv-date">${post.displayDate}</span>
        </div>
        <h2 class="nv-card-title">${post.title}</h2>
        <div class="nv-card-meta">
          <span>${post.readingTime}</span>
          <span>·</span>
          <span>${post.productHighlight}</span>
        </div>
        <p class="nv-card-desc">${post.excerpt}</p>
        <div class="nv-card-cta">
          <a class="nv-link" href="${post.detailPage}">Read article</a>
          <a class="nv-link secondary" href="${post.productPage}">View product picks</a>
        </div>
      </div>
      <div class="nv-card-thumb">
        <img src="${post.heroImage}" alt="${post.title}" loading="lazy" />
        <div class="nv-card-thumb-overlay"></div>
      </div>
    `;
    container.appendChild(card);
  });

  const pageInfo = document.getElementById("pageInfo");
  const prevBtn = document.getElementById("prevPage");
  const nextBtn = document.getElementById("nextPage");

  if (pageInfo) {
    pageInfo.textContent = `${currentPage} / ${totalPages}`;
  }
  if (prevBtn && nextBtn) {
    prevBtn.disabled = currentPage === 1;
    nextBtn.disabled = currentPage === totalPages;

    prevBtn.onclick = () => renderPosts(currentPage - 1);
    nextBtn.onclick = () => renderPosts(currentPage + 1);
  }
}

document.addEventListener("DOMContentLoaded", () => {
  const categorySelect = document.getElementById("categoryFilter");
  const searchInput = document.getElementById("searchInput");
  const quickCats = document.getElementById("quickCategories");

  if (categorySelect) {
    categorySelect.addEventListener("change", () => renderPosts(1));
  }
  if (searchInput) {
    searchInput.addEventListener("input", () => renderPosts(1));
  }
  if (quickCats && categorySelect) {
    quickCats.addEventListener("click", (e) => {
      const target = /** @type {HTMLElement} */ (e.target);
      if (target && target.dataset && target.dataset.cat) {
        categorySelect.value = target.dataset.cat;
        renderPosts(1);
      }
    });
  }

  renderPosts(1);
});

// ==================== 产品模块渲染 ====================
// 由脚本自动添加 - 2026-02-13

/**
 * 渲染产品推荐模块
 * @param {Array} products - 产品数组
 */
function renderProducts(products) {
  var section = document.getElementById('products-section');
  var container = document.getElementById('products-container');
  
  if (!section || !container) {
    return;
  }
  
  if (!products || !Array.isArray(products) || products.length === 0) {
    section.style.display = 'none';
    return;
  }
  
  section.style.display = 'block';
  
  container.innerHTML = products.map(function(product) {
    var imageHtml = product.image 
      ? '<img src="' + product.image + '" alt="' + (product.name || 'Product') + '" loading="lazy" onerror="this.style.display=\'none\'">'
      : '';
    
    var descHtml = product.description 
      ? '<p>' + product.description + '</p>' 
      : '';
    
    var priceHtml = product.price 
      ? '<span class="price">' + product.price + '</span>' 
      : '';
    
    var linkHtml = product.link 
      ? '<a href="' + product.link + '" class="buy-btn" target="_blank" rel="noopener nofollow">View Details</a>'
      : '';
    
    return '<div class="product-card">' +
      imageHtml +
      '<div class="product-card-body">' +
        '<h4>' + (product.name || 'Product') + '</h4>' +
        descHtml +
        priceHtml +
        linkHtml +
      '</div>' +
    '</div>';
  }).join('');
}

// ==================== 产品模块结束 ====================
