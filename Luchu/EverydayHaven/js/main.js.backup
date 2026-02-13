// Global variables
let currentCategory = 'all';
let currentPage = 1;
const articlesPerPage = 6;
let filteredArticles = [];

// Initialize filteredArticles when articles data is available
function initializeFilteredArticles() {
    if (typeof articlesIndex !== 'undefined' && articlesIndex && articlesIndex.length > 0 && window.articlesDataLoaded) {
        filteredArticles = [...articlesIndex];
    } else {
        filteredArticles = [];
    }
}

// Initialize - use multiple strategies to ensure scripts load correctly on Cloudflare Pages
function initializeApp() {
    initializeNavigation();
    initializeFilters();
    initializeSearch();
    
    // Initialize filtered articles
    initializeFilteredArticles();
    
    // Check if articles grid exists on this page (index page)
    const articlesGrid = document.getElementById('articlesGrid');
    if (articlesGrid) {
        // Ensure articles data is loaded before displaying
        let retryCount = 0;
        const maxRetries = 100; // Increased retries for Cloudflare Pages
        
        function tryDisplayArticles() {
            // Check if articles data is available and articles-index.js has loaded
            if (typeof articlesIndex !== 'undefined' && articlesIndex && Array.isArray(articlesIndex) && articlesIndex.length > 0 && window.articlesDataLoaded) {
                try {
                    initializeFilteredArticles();
                    displayArticles();
                    initializePagination();
                } catch (error) {
                    console.error('Error displaying articles:', error);
                    const grid = document.getElementById('articlesGrid');
                    if (grid) {
                        grid.innerHTML = `
                            <div style="grid-column: 1 / -1; text-align: center; padding: 4rem;">
                                <h2 style="color: var(--primary-gold); margin-bottom: 1rem;">Error loading articles</h2>
                                <p style="color: var(--text-light);">Please check the console for details.</p>
                            </div>
                        `;
                    }
                }
            } else if (retryCount < maxRetries) {
                retryCount++;
                // Wait for articles data to load
                setTimeout(tryDisplayArticles, 50); // Reduced interval for faster detection
            } else {
                // If articles still not loaded after max retries, show error message
                console.error('Articles data not loaded after', maxRetries, 'retries');
                console.error('articlesIndex variable:', typeof articlesIndex, articlesIndex);
                const grid = document.getElementById('articlesGrid');
                if (grid) {
                    grid.innerHTML = `
                        <div style="grid-column: 1 / -1; text-align: center; padding: 4rem;">
                            <h2 style="color: var(--primary-gold); margin-bottom: 1rem;">Unable to load articles</h2>
                            <p style="color: var(--text-light); margin-bottom: 1rem;">Please refresh the page to try again.</p>
                            <p style="color: var(--text-light); font-size: 0.9rem;">If the problem persists, please check the browser console for errors.</p>
                        </div>
                    `;
                }
            }
        }
        tryDisplayArticles();
    }
}

// Try multiple initialization strategies for Cloudflare Pages compatibility
if (document.readyState === 'loading') {
    // DOM is still loading
    document.addEventListener('DOMContentLoaded', function() {
        // Wait a bit more to ensure articles-index.js is loaded
        setTimeout(initializeApp, 100);
    });
} else if (document.readyState === 'interactive' || document.readyState === 'complete') {
    // DOM is already loaded
    setTimeout(initializeApp, 100);
} else {
    // Fallback
    window.addEventListener('load', function() {
        setTimeout(initializeApp, 100);
    });
}

// Navigation initialization
function initializeNavigation() {
    // Category dropdown links
    const categoryLinks = document.querySelectorAll('.dropdown-menu a[data-category]');
    categoryLinks.forEach(link => {
        link.addEventListener('click', (e) => {
            e.preventDefault();
            const category = link.getAttribute('data-category');
            filterByCategory(category);
        });
    });
}

// Filter initialization
function initializeFilters() {
    const filterButtons = document.querySelectorAll('.filter-btn');
    if (filterButtons.length === 0) return; // No filter buttons on article pages
    
    filterButtons.forEach(btn => {
        btn.addEventListener('click', () => {
            const category = btn.getAttribute('data-category');
            filterByCategory(category);
            
            // Update active state
            filterButtons.forEach(b => b.classList.remove('active'));
            btn.classList.add('active');
        });
    });
}

// Filter by category
function filterByCategory(category) {
    currentCategory = category;
    currentPage = 1;
    
    // Ensure articles data is available
    if (typeof articlesIndex === 'undefined' || !articlesIndex || articlesIndex.length === 0) {
        initializeFilteredArticles();
    }
    
    if (category === 'all') {
        filteredArticles = [...articlesIndex];
    } else {
        filteredArticles = articlesIndex.filter(article => article.category === category);
    }
    
    displayArticles();
    updatePagination();
}

// Search functionality
function initializeSearch() {
    const searchInput = document.getElementById('searchInput');
    const searchBtn = document.getElementById('searchBtn');
    
    if (!searchInput || !searchBtn) return;
    
    const performSearch = () => {
        const query = searchInput.value.toLowerCase().trim();
        
        // Check if we're on the article page or other non-index pages
        const isArticlePage = window.location.pathname.includes('article.html') || 
                             window.location.pathname.includes('about.html') || 
                             window.location.pathname.includes('contact.html');
        
        if (isArticlePage) {
            // Redirect to index page with search query
            if (query) {
                window.location.href = `index.html?search=${encodeURIComponent(query)}`;
            } else {
                window.location.href = 'index.html';
            }
            return;
        }
        
        // Ensure articles data is available and articles-index.js has loaded
        if (typeof articlesIndex === 'undefined' || !articlesIndex || articlesIndex.length === 0 || !window.articlesDataLoaded) {
            initializeFilteredArticles();
            return;
        }
        
        // On index page, perform search
        if (query === '') {
            if (currentCategory === 'all') {
                filteredArticles = [...articlesIndex];
            } else {
                filteredArticles = articlesIndex.filter(article => article.category === currentCategory);
            }
        } else {
            filteredArticles = articlesIndex.filter(article => {
                const matchesCategory = currentCategory === 'all' || article.category === currentCategory;
                const matchesSearch = 
                    article.title.toLowerCase().includes(query) ||
                    (article.excerpt && article.excerpt.toLowerCase().includes(query));
                return matchesCategory && matchesSearch;
            });
        }
        
        currentPage = 1;
        displayArticles();
        updatePagination();
    };
    
    searchBtn.addEventListener('click', performSearch);
    searchInput.addEventListener('keypress', (e) => {
        if (e.key === 'Enter') {
            performSearch();
        }
    });
    
    // Check for search query in URL parameters (when redirected from other pages)
    const urlParams = new URLSearchParams(window.location.search);
    const searchQuery = urlParams.get('search');
    if (searchQuery && !window.location.pathname.includes('article.html')) {
        searchInput.value = searchQuery;
        performSearch();
    }
}

// Display articles
function displayArticles() {
    const articlesGrid = document.getElementById('articlesGrid');
    
    // Return early if articlesGrid doesn't exist (e.g., on article page)
    if (!articlesGrid) return;
    
    if (filteredArticles.length === 0) {
        articlesGrid.innerHTML = `
            <div style="grid-column: 1 / -1; text-align: center; padding: 4rem;">
                <h2 style="color: var(--primary-gold); margin-bottom: 1rem;">No articles found</h2>
                <p style="color: var(--text-light);">Try adjusting your search or filter criteria.</p>
            </div>
        `;
        return;
    }
    
    const startIndex = (currentPage - 1) * articlesPerPage;
    const endIndex = startIndex + articlesPerPage;
    const articlesToShow = filteredArticles.slice(startIndex, endIndex);
    
    articlesGrid.innerHTML = articlesToShow.map(article => {
        const slug = generateSlug(article.title);
        return `
        <article class="article-card" onclick="window.location.href='article.html?name=${slug}'">
            <img src="${article.image}" alt="${article.title}" class="article-image">
            <div class="article-content">
                <div class="article-category">${categoryNames[article.category]}</div>
                <h2 class="article-title">${article.title}</h2>
                <p class="article-excerpt">${article.excerpt}</p>
                <div class="article-meta">
                    <span>${formatDate(article.date)}</span>
                </div>
            </div>
        </article>
    `;
    }).join('');
}

// Pagination
function initializePagination() {
    updatePagination();
}

function updatePagination() {
    const pagination = document.getElementById('pagination');
    
    // Return early if pagination doesn't exist (e.g., on article page)
    if (!pagination) return;
    
    const totalPages = Math.ceil(filteredArticles.length / articlesPerPage);
    
    if (totalPages <= 1) {
        pagination.innerHTML = '';
        return;
    }
    
    let paginationHTML = '';
    
    // Previous button
    paginationHTML += `
        <button ${currentPage === 1 ? 'disabled' : ''} onclick="changePage(${currentPage - 1})">
            ‹
        </button>
    `;
    
    // Page numbers
    for (let i = 1; i <= totalPages; i++) {
        if (i === 1 || i === totalPages || (i >= currentPage - 1 && i <= currentPage + 1)) {
            paginationHTML += `
                <button class="${i === currentPage ? 'active' : ''}" onclick="changePage(${i})">
                    ${i}
                </button>
            `;
        } else if (i === currentPage - 2 || i === currentPage + 2) {
            paginationHTML += `<span style="color: var(--text-light); padding: 0 0.5rem;">...</span>`;
        }
    }
    
    // Next button
    paginationHTML += `
        <button ${currentPage === totalPages ? 'disabled' : ''} onclick="changePage(${currentPage + 1})">
            ›
        </button>
    `;
    
    pagination.innerHTML = paginationHTML;
}

function changePage(page) {
    currentPage = page;
    displayArticles();
    updatePagination();
    window.scrollTo({ top: 0, behavior: 'smooth' });
}

// Format date
function formatDate(dateString) {
    const date = new Date(dateString);
    const options = { year: 'numeric', month: 'long', day: 'numeric' };
    return date.toLocaleDateString('en-US', options);
}

// Generate slug from title
function generateSlug(title) {
    return title
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/(^-|-$)/g, '');
}

// ===============================================
// 文章详情页加载逻辑（异步加载单篇文章）
// ===============================================

/**
 * 从索引中查找文章
 */
function findInIndex(idOrSlug) {
    // 按ID查找
    let article = articlesIndex.find(a => String(a.id) === String(idOrSlug));
    // 按slug查找
    if (!article) {
        article = articlesIndex.find(a => {
            const articleSlugGenerated = generateSlug(a.title);
            return articleSlugGenerated === idOrSlug;
        });
    }
    return article;
}

/**
 * 异步加载文章完整内容
 */
async function loadArticleContent(id) {
    try {
        const response = await fetch(`js/articles/${id}.json`);
        if (!response.ok) {
            throw new Error('文章加载失败');
        }
        return await response.json();
    } catch (error) {
        console.error('加载文章失败:', error);
        return null;
    }
}

/**
 * 渲染文章内容
 */
function renderArticleContent(article) {
    const articleHeader = document.querySelector('.article-header');
    const articleBody = document.querySelector('.article-body');
    const productRecs = document.querySelector('.product-recommendations');
    
    if (articleHeader) {
        articleHeader.innerHTML = `
            <img src="${article.image}" alt="${article.title}" class="article-header-image">
            <h1>${article.title}</h1>
            <div class="article-header-meta">
                <span>${categoryNames[article.category]}</span>
                <span>${formatDate(article.date)}</span>
                <span>By ${article.author}</span>
            </div>
        `;
    }
    
    if (articleBody) {
        articleBody.innerHTML = article.content;
    }
    
    if (productRecs && article.products && article.products.length > 0) {
        productRecs.innerHTML = `
            <h2>Recommended Products</h2>
            <div class="products-grid">
                ${article.products.map(product => `
                    <div class="product-card">
                        <img src="${product.image}" alt="${product.name}" class="product-image">
                        <h3 class="product-name">${product.name}</h3>
                        <p class="product-description">${product.description}</p>
                    </div>
                `).join('')}
            </div>
        `;
    }
    
    // Update page title
    document.title = `${article.title} - EverydayHaven`;
}

/**
 * 显示错误页面
 */
function showArticleError(message) {
    const articlePage = document.querySelector('.article-page');
    if (articlePage) {
        articlePage.innerHTML = `
            <div style="text-align: center; padding: 4rem;">
                <h1 style="color: var(--primary-gold);">Article Not Found</h1>
                <p style="color: var(--text-light); margin-top: 1rem;">${message}</p>
                <p style="color: var(--text-light); margin-top: 1rem;">
                    <a href="index.html" style="color: var(--primary-gold);">Return to Home</a>
                </p>
            </div>
        `;
    }
}

/**
 * 显示加载中
 */
function showLoading() {
    const articlePage = document.querySelector('.article-page');
    if (articlePage) {
        articlePage.innerHTML = `
            <div style="text-align: center; padding: 4rem;">
                <p style="color: var(--text-light);">Loading article...</p>
            </div>
        `;
    }
}

/**
 * Article page functionality - 异步加载文章
 */
async function loadArticle() {
    const urlParams = new URLSearchParams(window.location.search);
    const articleSlug = urlParams.get('name');
    const articleId = urlParams.get('id'); // Keep backward compatibility
    
    if (!articleSlug && !articleId) {
        showArticleError('No article specified.');
        return;
    }
    
    // Find article in index
    const indexData = findInIndex(articleSlug || articleId);
    
    if (!indexData) {
        showArticleError(`Could not find article with ${articleSlug ? 'slug: ' + articleSlug : 'ID: ' + articleId}`);
        return;
    }
    
    // Load full article content from JSON file
    const article = await loadArticleContent(indexData.id);
    
    if (!article) {
        showArticleError('Failed to load article content.');
        return;
    }
    
    // Render the article
    renderArticleContent(article);
}

// Check if we're on article page and load article
function checkAndLoadArticle() {
    const pathname = window.location.pathname;
    const href = window.location.href;
    const urlParams = new URLSearchParams(window.location.search);
    const hasArticleParam = urlParams.has('name') || urlParams.has('id');
    
    // Check if we're on article page (supports both /article and /article.html)
    const isArticlePage = pathname.includes('article') || href.includes('article') || hasArticleParam;
    
    if (isArticlePage) {
        // Ensure articles index is loaded and articles-index.js has loaded
        if (typeof articlesIndex === 'undefined' || !articlesIndex || articlesIndex.length === 0 || !window.articlesDataLoaded) {
            // Wait a bit more for articles-index.js to load
            setTimeout(checkAndLoadArticle, 100);
            return;
        }
        
        // DOM should be ready, load article
        loadArticle();
    }
}

// Initialize article loading - use same strategy as main initialization
function initializeArticlePage() {
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', function() {
            setTimeout(checkAndLoadArticle, 100);
        });
    } else {
        setTimeout(checkAndLoadArticle, 100);
    }
}

// Initialize article loading when page loads
initializeArticlePage();
