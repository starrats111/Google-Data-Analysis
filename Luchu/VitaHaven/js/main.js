// Main JavaScript functionality

// Initialize when DOM is loaded
document.addEventListener('DOMContentLoaded', function() {
    initializePage();
    setupEventListeners();
});

// Initialize page based on current page
function initializePage() {
    const path = window.location.pathname;
    const page = path.split('/').pop() || 'index.html';
    
    // Handle routes without .html extension (for GitHub Pages)
    if (page === 'index.html' || page === '' || page === 'index') {
        displayArticles();
        setupPagination();
    } else if (page === 'article.html' || page === 'article') {
        displayArticleDetail();
    } else if (page === 'category.html' || page === 'category') {
        displayCategoryArticles();
    }
}

// Setup event listeners
function setupEventListeners() {
    // Search functionality
    const searchToggle = document.querySelector('.search-toggle');
    const searchOverlay = document.querySelector('.search-overlay');
    const searchClose = document.querySelector('.search-close');
    const searchInput = document.getElementById('searchInput');
    const heroSearch = document.getElementById('heroSearch');
    
    if (searchToggle) {
        searchToggle.addEventListener('click', () => {
            searchOverlay.classList.add('active');
            searchInput.focus();
        });
    }
    
    if (searchClose) {
        searchClose.addEventListener('click', () => {
            searchOverlay.classList.remove('active');
        });
    }
    
    if (searchOverlay) {
        searchOverlay.addEventListener('click', (e) => {
            if (e.target === searchOverlay) {
                searchOverlay.classList.remove('active');
            }
        });
    }
    
    if (searchInput) {
        let searchTimeout;
        searchInput.addEventListener('input', (e) => {
            clearTimeout(searchTimeout);
            searchTimeout = setTimeout(() => {
                performSearch(e.target.value);
            }, 300);
        });
    }
    
    if (heroSearch) {
        heroSearch.addEventListener('keypress', (e) => {
            if (e.key === 'Enter') {
                e.preventDefault();
                const query = e.target.value;
                if (query.trim()) {
                    window.location.href = `category.html?search=${encodeURIComponent(query)}`;
                }
            }
        });
    }
    
    // Mobile menu toggle
    const mobileMenuToggle = document.querySelector('.mobile-menu-toggle');
    const nav = document.querySelector('.nav');
    
    if (mobileMenuToggle && nav) {
        mobileMenuToggle.addEventListener('click', () => {
            nav.classList.toggle('active');
        });
    }
    
    // Newsletter form
    const newsletterForm = document.querySelector('.newsletter-form');
    if (newsletterForm) {
        newsletterForm.addEventListener('submit', (e) => {
            e.preventDefault();
            const email = e.target.querySelector('input[type="email"]').value;
            if (email) {
                alert('Thank you for subscribing! We\'ll keep you updated with our latest articles.');
                e.target.reset();
            }
        });
    }
    
    // Contact form
    const contactForm = document.querySelector('.contact-form form');
    if (contactForm) {
        contactForm.addEventListener('submit', (e) => {
            e.preventDefault();
            alert('Thank you for your message! We\'ll get back to you soon.');
            contactForm.reset();
        });
    }
}

// Display articles on homepage
function displayArticles(page = 1, articlesPerPage = 6) {
    const articlesGrid = document.getElementById('articlesGrid');
    if (!articlesGrid) return;
    
    const startIndex = (page - 1) * articlesPerPage;
    const endIndex = startIndex + articlesPerPage;
    const articlesToShow = articles.slice(startIndex, endIndex);
    
    articlesGrid.innerHTML = articlesToShow.map(article => {
        const slug = generateSlug(article.title);
        return `
        <a href="article.html?title=${encodeURIComponent(slug)}" class="article-card">
            <img src="${article.image}" alt="${article.title}" class="article-image">
            <div class="article-content">
                <span class="article-category">${article.categoryName}</span>
                <h3 class="article-title">${article.title}</h3>
                <p class="article-excerpt">${article.excerpt}</p>
                <div class="article-meta">
                    <span class="article-date">
                        <i class="far fa-calendar"></i>
                        ${formatDate(article.date)}
                    </span>
                </div>
            </div>
        </a>
    `;
    }).join('');
}

// Setup pagination
function setupPagination() {
    const pagination = document.getElementById('pagination');
    if (!pagination) return;
    
    const articlesPerPage = 6;
    const totalPages = Math.ceil(articles.length / articlesPerPage);
    const currentPage = getCurrentPage() || 1;
    
    let paginationHTML = '';
    
    // Previous button
    paginationHTML += `
        <button ${currentPage === 1 ? 'disabled' : ''} onclick="goToPage(${currentPage - 1})">
            <i class="fas fa-chevron-left"></i>
        </button>
    `;
    
    // Page numbers
    for (let i = 1; i <= totalPages; i++) {
        if (i === 1 || i === totalPages || (i >= currentPage - 1 && i <= currentPage + 1)) {
            paginationHTML += `
                <button class="${i === currentPage ? 'active' : ''}" onclick="goToPage(${i})">
                    ${i}
                </button>
            `;
        } else if (i === currentPage - 2 || i === currentPage + 2) {
            paginationHTML += `<span>...</span>`;
        }
    }
    
    // Next button
    paginationHTML += `
        <button ${currentPage === totalPages ? 'disabled' : ''} onclick="goToPage(${currentPage + 1})">
            <i class="fas fa-chevron-right"></i>
        </button>
    `;
    
    pagination.innerHTML = paginationHTML;
}

// Go to specific page
function goToPage(page) {
    const articlesPerPage = 6;
    const totalPages = Math.ceil(articles.length / articlesPerPage);
    
    if (page < 1 || page > totalPages) return;
    
    displayArticles(page);
    setupPagination();
    window.scrollTo({ top: 0, behavior: 'smooth' });
}

// Get current page from URL
function getCurrentPage() {
    const params = new URLSearchParams(window.location.search);
    return parseInt(params.get('page')) || 1;
}

// Display article detail
function displayArticleDetail() {
    const params = new URLSearchParams(window.location.search);
    const titleSlug = params.get('title');
    
    // Support both old id format and new title format for backward compatibility
    let article;
    if (titleSlug) {
        // Find article by matching slug
        article = articles.find(a => generateSlug(a.title) === titleSlug);
    } else {
        // Fallback to id for backward compatibility
        const articleId = parseInt(params.get('id'));
        if (articleId) {
            article = articles.find(a => a.id === articleId);
        }
    }
    
    if (!article) {
        window.location.href = 'index.html';
        return;
    }
    
    // Update page title
    document.title = `${article.title} - VitaHaven`;
    
    // Create article detail HTML
    const articleHTML = `
        <article class="article-detail">
            <div class="container">
                <div class="article-header">
                    <span class="article-category">${article.categoryName}</span>
                    <h1 class="article-title">${article.title}</h1>
                    <div class="article-meta">
                        <span class="article-date">
                            <i class="far fa-calendar"></i>
                            ${formatDate(article.date)}
                        </span>
                    </div>
                </div>
                
                <img src="${article.image}" alt="${article.title}" class="article-featured-image">
                
                <div class="article-body">
                    ${article.content}
                </div>
                
                ${article.products && article.products.length > 0 ? `
                    <div class="product-section">
                        <h2>Recommended Products</h2>
                        <div class="product-grid">
                            ${article.products.map(product => `
                                <div class="product-card">
                                    <img src="${product.image}" alt="${product.name}" class="product-image">
                                    <div class="product-info">
                                        <h3 class="product-name">${product.name}</h3>
                                        <p class="product-description">${product.description}</p>
                                    </div>
                                </div>
                            `).join('')}
                        </div>
                    </div>
                ` : ''}
            </div>
        </article>
    `;
    
    // Insert before footer
    const footer = document.querySelector('.footer');
    if (footer) {
        footer.insertAdjacentHTML('beforebegin', articleHTML);
    }
}

// Display category articles
function displayCategoryArticles() {
    const params = new URLSearchParams(window.location.search);
    const category = params.get('cat');
    const searchQuery = params.get('search');
    
    let filteredArticles = articles;
    
    if (category) {
        filteredArticles = articles.filter(a => a.category === category);
    }
    
    if (searchQuery) {
        const query = searchQuery.toLowerCase();
        filteredArticles = filteredArticles.filter(a => 
            a.title.toLowerCase().includes(query) ||
            a.excerpt.toLowerCase().includes(query) ||
            a.content.toLowerCase().includes(query)
        );
    }
    
    const articlesGrid = document.getElementById('articlesGrid');
    if (articlesGrid) {
        if (filteredArticles.length === 0) {
            articlesGrid.innerHTML = `
                <div style="grid-column: 1 / -1; text-align: center; padding: 3rem;">
                    <h3>No articles found</h3>
                    <p>Try adjusting your search or browse our categories.</p>
                </div>
            `;
        } else {
            articlesGrid.innerHTML = filteredArticles.map(article => {
                const slug = generateSlug(article.title);
                return `
                <a href="article.html?title=${encodeURIComponent(slug)}" class="article-card">
                    <img src="${article.image}" alt="${article.title}" class="article-image">
                    <div class="article-content">
                        <span class="article-category">${article.categoryName}</span>
                        <h3 class="article-title">${article.title}</h3>
                        <p class="article-excerpt">${article.excerpt}</p>
                        <div class="article-meta">
                            <span class="article-date">
                                <i class="far fa-calendar"></i>
                                ${formatDate(article.date)}
                            </span>
                        </div>
                    </div>
                </a>
            `;
            }).join('');
        }
    }
    
    // Update page title
    if (category && categories[category]) {
        document.title = `${categories[category]} - VitaHaven`;
    } else if (searchQuery) {
        document.title = `Search: ${searchQuery} - VitaHaven`;
    }
}

// Perform search
function performSearch(query) {
    const searchResults = document.getElementById('searchResults');
    if (!searchResults) return;
    
    if (!query.trim()) {
        searchResults.innerHTML = '';
        return;
    }
    
    const queryLower = query.toLowerCase();
    const results = articles.filter(article => 
        article.title.toLowerCase().includes(queryLower) ||
        article.excerpt.toLowerCase().includes(queryLower) ||
        article.categoryName.toLowerCase().includes(queryLower)
    );
    
    if (results.length === 0) {
        searchResults.innerHTML = '<div class="search-result-item">No results found</div>';
        return;
    }
    
    searchResults.innerHTML = results.map(article => {
        const slug = generateSlug(article.title);
        return `
        <div class="search-result-item" onclick="window.location.href='article.html?title=${encodeURIComponent(slug)}'">
            <h4>${highlightText(article.title, query)}</h4>
            <p style="color: var(--color-text-light); font-size: 0.9rem; margin-top: 0.5rem;">
                ${highlightText(article.excerpt.substring(0, 100) + '...', query)}
            </p>
            <span style="display: inline-block; margin-top: 0.5rem; font-size: 0.85rem; color: var(--color-primary);">
                ${article.categoryName}
            </span>
        </div>
    `;
    }).join('');
}

// Highlight search text
function highlightText(text, query) {
    if (!query) return text;
    const regex = new RegExp(`(${query})`, 'gi');
    return text.replace(regex, '<mark>$1</mark>');
}

// Generate URL-friendly slug from title
function generateSlug(title) {
    return title
        .toLowerCase()
        .trim()
        .replace(/[^\w\s-]/g, '') // Remove special characters
        .replace(/[\s_-]+/g, '-') // Replace spaces and underscores with hyphens
        .replace(/^-+|-+$/g, ''); // Remove leading/trailing hyphens
}

// Format date
function formatDate(dateString) {
    const date = new Date(dateString);
    const options = { year: 'numeric', month: 'long', day: 'numeric' };
    return date.toLocaleDateString('en-US', options);
}

// Smooth scroll for anchor links
document.querySelectorAll('a[href^="#"]').forEach(anchor => {
    anchor.addEventListener('click', function (e) {
        e.preventDefault();
        const target = document.querySelector(this.getAttribute('href'));
        if (target) {
            target.scrollIntoView({
                behavior: 'smooth',
                block: 'start'
            });
        }
    });
});

// Add animation on scroll
const observerOptions = {
    threshold: 0.1,
    rootMargin: '0px 0px -50px 0px'
};

const observer = new IntersectionObserver((entries) => {
    entries.forEach(entry => {
        if (entry.isIntersecting) {
            entry.target.style.opacity = '1';
            entry.target.style.transform = 'translateY(0)';
        }
    });
}, observerOptions);

// Observe elements for animation
document.addEventListener('DOMContentLoaded', () => {
    const animatedElements = document.querySelectorAll('.article-card, .category-card, .product-card');
    animatedElements.forEach(el => {
        el.style.opacity = '0';
        el.style.transform = 'translateY(20px)';
        el.style.transition = 'opacity 0.6s ease, transform 0.6s ease';
        observer.observe(el);
    });
});



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
