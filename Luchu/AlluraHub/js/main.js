// Main JavaScript functionality

// Navigation scroll behavior
let lastScrollTop = 0;
let scrollTimeout = null;
let header = null;

function handleScroll() {
    if (!header) return;
    
    const currentPage = window.location.pathname.split('/').pop() || 'index.html';
    const isArticlePage = currentPage.startsWith('article-');
    const scrollTop = window.pageYOffset || document.documentElement.scrollTop;
    
    // Clear existing timeout
    if (scrollTimeout) {
        clearTimeout(scrollTimeout);
    }
    
    // For article pages, hide header by default but show at top
    if (isArticlePage) {
        if (scrollTop < 50) {
            // At the top, show header
            header.classList.remove('hidden');
        } else {
            // Show on scroll up, hide on scroll down
            if (scrollTop > lastScrollTop && scrollTop > 100) {
                // Scrolling down
                header.classList.add('hidden');
            } else if (scrollTop < lastScrollTop) {
                // Scrolling up
                header.classList.remove('hidden');
            }
        }
    } else {
        // For other pages, normal behavior
        if (scrollTop > lastScrollTop && scrollTop > 100) {
            // Scrolling down
            header.classList.add('hidden');
        } else {
            // Scrolling up or at top
            header.classList.remove('hidden');
        }
    }
    
    lastScrollTop = scrollTop <= 0 ? 0 : scrollTop;
}

// Initialize page
document.addEventListener('DOMContentLoaded', function() {
    header = document.querySelector('.main-header');
    const currentPage = window.location.pathname.split('/').pop() || 'index.html';
    
    // Set search input value if search parameter exists
    const urlParams = new URLSearchParams(window.location.search);
    const searchParam = urlParams.get('search');
    const searchInput = document.getElementById('searchInput');
    if (searchInput && searchParam) {
        searchInput.value = searchParam;
    }
    
    // Initialize header state for article pages - hide by default
    if (currentPage.startsWith('article-')) {
        if (header && window.pageYOffset > 50) {
            header.classList.add('hidden');
        }
    }
    
    if (currentPage === 'index.html' || currentPage === '') {
        displayArticles(articles, 1);
    } else if (currentPage === 'category.html') {
        handleCategoryPage();
    } else if (currentPage.startsWith('article-')) {
        handleArticlePage();
    }
    
    // Search functionality
    if (searchInput) {
        searchInput.addEventListener('keypress', function(e) {
            if (e.key === 'Enter') {
                performSearch();
            }
        });
    }
    
    // Add scroll event listener with throttling
    let ticking = false;
    window.addEventListener('scroll', function() {
        if (!ticking) {
            window.requestAnimationFrame(function() {
                handleScroll();
                ticking = false;
            });
            ticking = true;
        }
    }, { passive: true });
});

// Display articles with pagination
function displayArticles(articlesToShow, page = 1) {
    const articlesPerPage = 6;
    const startIndex = (page - 1) * articlesPerPage;
    const endIndex = startIndex + articlesPerPage;
    const paginatedArticles = articlesToShow.slice(startIndex, endIndex);
    
    const articlesGrid = document.getElementById('articlesGrid');
    if (!articlesGrid) return;
    
    articlesGrid.innerHTML = '';
    
    paginatedArticles.forEach(article => {
        const articleCard = createArticleCard(article);
        articlesGrid.appendChild(articleCard);
    });
    
    // Create pagination
    createPagination(articlesToShow.length, articlesPerPage, page);
}

// Create article card
function createArticleCard(article) {
    const card = document.createElement('div');
    card.className = 'article-card';
    card.onclick = () => {
        window.location.href = `article-${article.id}.html`;
    };
    
    const formattedDate = new Date(article.date).toLocaleDateString('en-US', {
        year: 'numeric',
        month: 'long',
        day: 'numeric'
    });
    
    card.innerHTML = `
        <img src="${article.image}" alt="${article.title}" class="article-image">
        <div class="article-content">
            <div class="article-meta">
                <span class="article-category">${categoryNames[article.category] || article.category}</span>
                <span class="article-date">${formattedDate}</span>
            </div>
            <h3 class="article-title">${article.title}</h3>
            <p class="article-excerpt">${article.excerpt}</p>
            <a href="article-${article.id}.html" class="read-more">Read More →</a>
        </div>
    `;
    
    return card;
}

// Create pagination
function createPagination(totalArticles, articlesPerPage, currentPage) {
    const totalPages = Math.ceil(totalArticles / articlesPerPage);
    const pagination = document.getElementById('pagination');
    if (!pagination || totalPages <= 1) {
        if (pagination) pagination.innerHTML = '';
        return;
    }
    
    pagination.innerHTML = '';
    
    // Previous button
    const prevBtn = document.createElement('button');
    prevBtn.textContent = '← Previous';
    prevBtn.disabled = currentPage === 1;
    prevBtn.onclick = () => {
        const articlesToShow = getFilteredArticles();
        displayArticles(articlesToShow, currentPage - 1);
        window.scrollTo({ top: 0, behavior: 'smooth' });
    };
    pagination.appendChild(prevBtn);
    
    // Page numbers
    for (let i = 1; i <= totalPages; i++) {
        if (i === 1 || i === totalPages || (i >= currentPage - 1 && i <= currentPage + 1)) {
            const pageBtn = document.createElement('button');
            pageBtn.textContent = i;
            pageBtn.className = i === currentPage ? 'active' : '';
            pageBtn.onclick = () => {
                const articlesToShow = getFilteredArticles();
                displayArticles(articlesToShow, i);
                window.scrollTo({ top: 0, behavior: 'smooth' });
            };
            pagination.appendChild(pageBtn);
        } else if (i === currentPage - 2 || i === currentPage + 2) {
            const ellipsis = document.createElement('span');
            ellipsis.textContent = '...';
            ellipsis.style.padding = '0.6rem 0.5rem';
            pagination.appendChild(ellipsis);
        }
    }
    
    // Next button
    const nextBtn = document.createElement('button');
    nextBtn.textContent = 'Next →';
    nextBtn.disabled = currentPage === totalPages;
    nextBtn.onclick = () => {
        const articlesToShow = getFilteredArticles();
        displayArticles(articlesToShow, currentPage + 1);
        window.scrollTo({ top: 0, behavior: 'smooth' });
    };
    pagination.appendChild(nextBtn);
}

// Get filtered articles (for search/category)
function getFilteredArticles() {
    const urlParams = new URLSearchParams(window.location.search);
    const category = urlParams.get('cat');
    const search = urlParams.get('search');
    
    let filtered = articles;
    
    if (category) {
        filtered = filtered.filter(article => article.category === category);
    }
    
    if (search) {
        const searchLower = search.toLowerCase();
        filtered = filtered.filter(article => 
            article.title.toLowerCase().includes(searchLower) ||
            article.excerpt.toLowerCase().includes(searchLower) ||
            article.content.toLowerCase().includes(searchLower)
        );
    }
    
    return filtered;
}

// Handle category page
function handleCategoryPage() {
    const urlParams = new URLSearchParams(window.location.search);
    const category = urlParams.get('cat');
    const search = urlParams.get('search');
    
    const categoryTitle = document.querySelector('.category-header h1');
    const categoryDesc = document.querySelector('.category-header p');
    
    if (search) {
        if (categoryTitle) {
            categoryTitle.textContent = 'Search Results';
        }
        if (categoryDesc) {
            categoryDesc.textContent = `Search results for "${search}"`;
        }
    } else if (category && categoryNames[category]) {
        if (categoryTitle) {
            categoryTitle.textContent = categoryNames[category];
        }
        if (categoryDesc) {
            categoryDesc.textContent = `Explore our curated collection of articles about ${categoryNames[category].toLowerCase()}.`;
        }
    }
    
    const filteredArticles = getFilteredArticles();
    displayArticles(filteredArticles, 1);
}

// Handle article detail page
function handleArticlePage() {
    const currentPage = window.location.pathname.split('/').pop();
    const articleId = parseInt(currentPage.replace('article-', '').replace('.html', ''));
    const article = articles.find(a => a.id === articleId);
    
    if (!article) {
        window.location.href = 'index.html';
        return;
    }
    
    const formattedDate = new Date(article.date).toLocaleDateString('en-US', {
        year: 'numeric',
        month: 'long',
        day: 'numeric'
    });
    
    // Update page title
    document.title = `${article.title} - AlluraHub`;
    
    // Update article header
    const articleHeader = document.querySelector('.article-header');
    if (articleHeader) {
        articleHeader.innerHTML = `
            <img src="${article.image}" alt="${article.title}" class="article-header-image">
            <h1 class="article-header-title">${article.title}</h1>
            <div class="article-header-meta">
                <span class="article-category">${categoryNames[article.category] || article.category}</span>
                <span class="article-date">${formattedDate}</span>
            </div>
        `;
    }
    
    // Update article body
    const articleBody = document.querySelector('.article-body');
    if (articleBody) {
        articleBody.innerHTML = article.content;
    }
    
    // Update product recommendations
    if (article.products && article.products.length > 0) {
        const productSection = document.querySelector('.product-section');
        if (productSection) {
            const productsGrid = productSection.querySelector('.products-grid');
            if (productsGrid) {
                productsGrid.innerHTML = '';
                article.products.forEach(product => {
                    const productCard = document.createElement('div');
                    productCard.className = 'product-card';
                    productCard.innerHTML = `
                        <img src="${product.image}" alt="${product.name}" class="product-image">
                        <div class="product-info">
                            <h3 class="product-name">${product.name}</h3>
                            <p class="product-description">${product.description}</p>
                        </div>
                    `;
                    productsGrid.appendChild(productCard);
                });
            }
        }
    }
}

// Search functionality
function performSearch() {
    const searchInput = document.getElementById('searchInput');
    const searchTerm = searchInput ? searchInput.value.trim() : '';
    
    if (searchTerm) {
        window.location.href = `category.html?search=${encodeURIComponent(searchTerm)}`;
    }
}



// ==================== 产品模块渲染 ====================
// 由脚本自动添加 - 2026-02-13

/**
 * 渲染产品推荐模块
 * @param {Array} products - 产品数组
 */
function renderProducts(products) {
  const section = document.getElementById('products-section');
  const container = document.getElementById('products-container');
  
  // 检查元素是否存在
  if (!section || !container) {
    console.log('Products section not found in this page');
    return;
  }
  
  // 如果没有产品数据，隐藏模块
  if (!products || !Array.isArray(products) || products.length === 0) {
    section.style.display = 'none';
    return;
  }
  
  // 显示模块并渲染产品
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
