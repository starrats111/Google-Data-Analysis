// Main JavaScript functionality

// Initialize on page load
document.addEventListener('DOMContentLoaded', function() {
    initializePage();
});

function initializePage() {
    const currentPage = getCurrentPage();
    
    switch(currentPage) {
        case 'index':
            loadRecommendedArticles();
            loadArticles();
            setupSearch();
            setupCategoryCards();
            break;
        case 'articles':
            loadArticles();
            setupFilterButtons();
            setupSearch();
            break;
        case 'category':
            loadCategoryPage();
            setupFilterButtons();
            setupSearch();
            break;
        case 'article':
            loadArticleDetail();
            break;
        case 'products':
            loadProducts();
            setupFilterButtons();
            break;
        case 'product':
            loadProductDetail();
            break;
        default:
            setupSearch();
    }
}

function getCurrentPage() {
    const path = window.location.pathname;
    // Support both /article and /article.html formats
    // Check exact match first (without .html), then with .html
    if (path === '/article' || path === '/article/' || path.includes('article.html')) return 'article';
    if (path === '/articles' || path === '/articles/' || path.includes('articles.html')) return 'articles';
    if (path === '/category' || path === '/category/' || path.includes('category.html')) return 'category';
    if (path === '/products' || path === '/products/' || path.includes('products.html')) return 'products';
    if (path === '/product' || path === '/product/' || path.includes('product.html')) return 'product';
    if (path === '/about' || path === '/about/' || path.includes('about.html')) return 'about';
    if (path === '/contact' || path === '/contact/' || path.includes('contact.html')) return 'contact';
    return 'index';
}

// Helper function to convert title/name to URL-friendly slug
function titleToSlug(title) {
    return title
        .toLowerCase()
        .replace(/[^\w\s-]/g, '') // Remove special characters
        .replace(/\s+/g, '-')      // Replace spaces with hyphens
        .replace(/-+/g, '-')       // Replace multiple hyphens with single
        .trim();
}

// Helper function to convert slug back to title for matching
function slugToTitle(slug) {
    return decodeURIComponent(slug.replace(/-/g, ' '));
}

// Load recommended articles on homepage
function loadRecommendedArticles() {
    const recommendedGrid = document.getElementById('recommendedGrid');
    const recommendedSection = document.querySelector('.recommended-section');
    if (!recommendedGrid) return;

    // Filter articles with featured flag
    const recommendedArticles = articles.filter(article => article.featured === true);
    
    if (recommendedArticles.length === 0) {
        recommendedGrid.innerHTML = '';
        // Hide the entire recommended section if no articles
        if (recommendedSection) {
            recommendedSection.style.display = 'none';
        }
        return;
    }
    
    // Show the section if it was hidden
    if (recommendedSection) {
        recommendedSection.style.display = '';
    }
    
    // Render recommended articles
    recommendedGrid.innerHTML = recommendedArticles.map(article => {
        const articleSlug = titleToSlug(article.title);
        return `
        <a href="article.html?title=${encodeURIComponent(articleSlug)}" class="recommended-card">
            <div class="recommended-image">
                <img src="${article.image}" alt="${article.title}">
                <span class="recommended-badge">Featured</span>
            </div>
            <div class="recommended-content">
                <div class="recommended-date">${formatDate(article.date)}</div>
                <h3 class="recommended-title">${article.title}</h3>
                <p class="recommended-excerpt">${article.excerpt}</p>
                <span class="recommended-read-more">Read More →</span>
            </div>
        </a>
    `;
    }).join('');
}

// Load articles on homepage
let currentPage = 1;
const articlesPerPage = 6;

function loadArticles(page = 1, filterCategory = null, searchTerm = null) {
    currentPage = page;
    const articlesGrid = document.getElementById('articlesGrid');
    if (!articlesGrid) return;

    let filteredArticles = [...articles];
    
    // Sort articles by date (newest first)
    filteredArticles.sort((a, b) => new Date(b.date) - new Date(a.date));
    
    // Apply category filter
    if (filterCategory && filterCategory !== 'all') {
        filteredArticles = filteredArticles.filter(article => article.category === filterCategory);
    }
    
    // Apply search filter
    if (searchTerm) {
        const term = searchTerm.toLowerCase();
        filteredArticles = filteredArticles.filter(article => 
            article.title.toLowerCase().includes(term) ||
            article.excerpt.toLowerCase().includes(term) ||
            article.content.toLowerCase().includes(term)
        );
    }
    
    // Calculate pagination
    const totalPages = Math.ceil(filteredArticles.length / articlesPerPage);
    const startIndex = (page - 1) * articlesPerPage;
    const endIndex = startIndex + articlesPerPage;
    const articlesToShow = filteredArticles.slice(startIndex, endIndex);
    
    // Render articles
    articlesGrid.innerHTML = articlesToShow.map(article => {
        const articleSlug = titleToSlug(article.title);
        return `
        <a href="article.html?title=${encodeURIComponent(articleSlug)}" class="article-card">
            <div class="article-image">
                <img src="${article.image}" alt="${article.title}">
                <span class="article-category">${categoryNames[article.category]}</span>
            </div>
            <div class="article-content">
                <div class="article-date">${formatDate(article.date)}</div>
                <h3 class="article-title">${article.title}</h3>
                <p class="article-excerpt">${article.excerpt}</p>
                <span class="article-read-more">Read More →</span>
            </div>
        </a>
    `;
    }).join('');
    
    // Show search results count
    if (searchTerm) {
        const resultsCount = document.createElement('div');
        resultsCount.className = 'search-results-count';
        resultsCount.innerHTML = `<strong>${filteredArticles.length}</strong> article${filteredArticles.length !== 1 ? 's' : ''} found for "<strong>${searchTerm}</strong>"`;
        
        // Remove existing count if any
        const existingCount = articlesGrid.parentElement.querySelector('.search-results-count');
        if (existingCount) {
            existingCount.remove();
        }
        
        articlesGrid.parentElement.insertBefore(resultsCount, articlesGrid);
    } else {
        // Remove count if no search
        const existingCount = articlesGrid.parentElement.querySelector('.search-results-count');
        if (existingCount) {
            existingCount.remove();
        }
    }
    
    // Render pagination
    renderPagination(page, totalPages, filterCategory, searchTerm);
}

function renderPagination(currentPage, totalPages, filterCategory, searchTerm) {
    const pagination = document.getElementById('pagination');
    if (!pagination) return;
    
    if (totalPages <= 1) {
        pagination.innerHTML = '';
        return;
    }
    
    let paginationHTML = '';
    
    // Previous button
    paginationHTML += `<button ${currentPage === 1 ? 'disabled' : ''} onclick="loadArticles(${currentPage - 1}, '${filterCategory || ''}', '${searchTerm || ''}')">Previous</button>`;
    
    // Page numbers
    for (let i = 1; i <= totalPages; i++) {
        if (i === 1 || i === totalPages || (i >= currentPage - 1 && i <= currentPage + 1)) {
            paginationHTML += `<button class="${i === currentPage ? 'active' : ''}" onclick="loadArticles(${i}, '${filterCategory || ''}', '${searchTerm || ''}')">${i}</button>`;
        } else if (i === currentPage - 2 || i === currentPage + 2) {
            paginationHTML += `<span>...</span>`;
        }
    }
    
    // Next button
    paginationHTML += `<button ${currentPage === totalPages ? 'disabled' : ''} onclick="loadArticles(${currentPage + 1}, '${filterCategory || ''}', '${searchTerm || ''}')">Next</button>`;
    
    pagination.innerHTML = paginationHTML;
}

function formatDate(dateString) {
    const date = new Date(dateString);
    const options = { year: 'numeric', month: 'long', day: 'numeric' };
    return date.toLocaleDateString('en-US', options);
}

// Search functionality
let searchTimeout;
let searchHistory = JSON.parse(localStorage.getItem('searchHistory') || '[]');
const maxHistoryItems = 5;

function setupSearch() {
    const searchInput = document.getElementById('searchInput');
    const searchBtn = document.getElementById('searchBtn');
    const searchBox = document.querySelector('.search-box');
    
    if (!searchInput || !searchBox) return;
    
    // Create search suggestions container
    if (!document.querySelector('.search-suggestions')) {
        const suggestionsDiv = document.createElement('div');
        suggestionsDiv.className = 'search-suggestions';
        searchBox.appendChild(suggestionsDiv);
    }
    
    // Create clear button
    if (!document.querySelector('.clear-search')) {
        const clearBtn = document.createElement('button');
        clearBtn.className = 'clear-search';
        clearBtn.innerHTML = '<svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="18" y1="6" x2="6" y2="18"></line><line x1="6" y1="6" x2="18" y2="18"></line></svg>';
        clearBtn.addEventListener('click', clearSearch);
        searchBox.querySelector('.search-box-wrapper')?.appendChild(clearBtn) || searchBox.appendChild(clearBtn);
    }
    
    // Real-time search suggestions
    searchInput.addEventListener('input', function() {
        const value = this.value.trim();
        const clearBtn = document.querySelector('.clear-search');
        
        if (clearBtn) {
            clearBtn.classList.toggle('visible', value.length > 0);
        }
        
        clearTimeout(searchTimeout);
        
        if (value.length > 0) {
            searchTimeout = setTimeout(() => {
                showSearchSuggestions(value);
            }, 300);
        } else {
            hideSearchSuggestions();
        }
    });
    
    // Enter key to search
    searchInput.addEventListener('keypress', function(e) {
        if (e.key === 'Enter') {
            e.preventDefault();
            performSearch();
        }
    });
    
    // Escape key to close suggestions
    searchInput.addEventListener('keydown', function(e) {
        if (e.key === 'Escape') {
            hideSearchSuggestions();
            this.blur();
        }
    });
    
    // Click outside to close suggestions
    document.addEventListener('click', function(e) {
        if (!searchBox.contains(e.target)) {
            hideSearchSuggestions();
        }
    });
    
    // Search button click
    if (searchBtn) {
        searchBtn.addEventListener('click', performSearch);
    }
    
    // Keyboard shortcut: / to focus search
    document.addEventListener('keydown', function(e) {
        if (e.key === '/' && !e.target.matches('input, textarea')) {
            e.preventDefault();
            searchInput.focus();
        }
    });
    
    // Show suggestions on focus if there's history
    searchInput.addEventListener('focus', function() {
        if (this.value.trim().length === 0 && searchHistory.length > 0) {
            showSearchSuggestions('');
        }
    });
    
    // Load search from URL
    const urlParams = new URLSearchParams(window.location.search);
    const searchParam = urlParams.get('search');
    if (searchParam) {
        searchInput.value = decodeURIComponent(searchParam);
        performSearch();
    }
}

function showSearchSuggestions(query) {
    const suggestionsDiv = document.querySelector('.search-suggestions');
    if (!suggestionsDiv) return;
    
    suggestionsDiv.innerHTML = '';
    suggestionsDiv.classList.add('active');
    
    // Get matching articles
    const matchingArticles = articles.filter(article => {
        if (!query) return false;
        const searchTerm = query.toLowerCase();
        return article.title.toLowerCase().includes(searchTerm) ||
               article.excerpt.toLowerCase().includes(searchTerm) ||
               article.category.toLowerCase().includes(searchTerm);
    }).slice(0, 5);
    
    // Get matching categories
    const matchingCategories = Object.entries(categoryNames).filter(([key, name]) => {
        if (!query) return false;
        return name.toLowerCase().includes(query.toLowerCase());
    }).slice(0, 3);
    
    // Show matching articles
    if (matchingArticles.length > 0) {
        const section = document.createElement('div');
        section.className = 'search-suggestions-section';
        section.innerHTML = '<div class="search-suggestions-section-title">Articles</div>';
        
        matchingArticles.forEach(article => {
            const item = document.createElement('div');
            item.className = 'search-suggestion-item';
            item.innerHTML = `
                <svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                    <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"></path>
                    <polyline points="14 2 14 8 20 8"></polyline>
                    <line x1="16" y1="13" x2="8" y2="13"></line>
                    <line x1="16" y1="17" x2="8" y2="17"></line>
                    <polyline points="10 9 9 9 8 9"></polyline>
                </svg>
                <div class="search-suggestion-item-text">
                    <div>${highlightMatch(article.title, query)}</div>
                    <div class="search-suggestion-item-category">${categoryNames[article.category]}</div>
                </div>
            `;
            item.addEventListener('click', () => {
                const articleSlug = titleToSlug(article.title);
                window.location.href = `article.html?title=${encodeURIComponent(articleSlug)}`;
            });
            section.appendChild(item);
        });
        
        suggestionsDiv.appendChild(section);
    }
    
    // Show matching categories
    if (matchingCategories.length > 0) {
        const section = document.createElement('div');
        section.className = 'search-suggestions-section';
        section.innerHTML = '<div class="search-suggestions-section-title">Categories</div>';
        
        matchingCategories.forEach(([key, name]) => {
            const item = document.createElement('div');
            item.className = 'search-suggestion-item';
            item.innerHTML = `
                <svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                    <rect x="3" y="3" width="7" height="7"></rect>
                    <rect x="14" y="3" width="7" height="7"></rect>
                    <rect x="14" y="14" width="7" height="7"></rect>
                    <rect x="3" y="14" width="7" height="7"></rect>
                </svg>
                <div class="search-suggestion-item-text">${highlightMatch(name, query)}</div>
            `;
            item.addEventListener('click', () => {
                window.location.href = `category.html?cat=${key}`;
            });
            section.appendChild(item);
        });
        
        suggestionsDiv.appendChild(section);
    }
    
    // Show search history if no query
    if (!query && searchHistory.length > 0) {
        const section = document.createElement('div');
        section.className = 'search-suggestions-section';
        section.innerHTML = '<div class="search-suggestions-section-title">Recent Searches</div>';
        
        searchHistory.slice(0, 5).forEach(term => {
            const item = document.createElement('div');
            item.className = 'search-suggestion-item';
            item.innerHTML = `
                <svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                    <circle cx="11" cy="11" r="8"></circle>
                    <path d="m21 21-4.35-4.35"></path>
                </svg>
                <div class="search-suggestion-item-text">${term}</div>
            `;
            item.addEventListener('click', () => {
                document.getElementById('searchInput').value = term;
                performSearch();
            });
            section.appendChild(item);
        });
        
        suggestionsDiv.appendChild(section);
    }
    
    // Show popular searches if no results
    if (matchingArticles.length === 0 && matchingCategories.length === 0 && query) {
        const emptyDiv = document.createElement('div');
        emptyDiv.className = 'search-suggestions-empty';
        emptyDiv.textContent = 'No results found. Try different keywords.';
        suggestionsDiv.appendChild(emptyDiv);
    }
}

function highlightMatch(text, query) {
    if (!query) return text;
    const regex = new RegExp(`(${query})`, 'gi');
    return text.replace(regex, '<strong>$1</strong>');
}

function hideSearchSuggestions() {
    const suggestionsDiv = document.querySelector('.search-suggestions');
    if (suggestionsDiv) {
        suggestionsDiv.classList.remove('active');
    }
}

function clearSearch() {
    const searchInput = document.getElementById('searchInput');
    if (searchInput) {
        searchInput.value = '';
        searchInput.focus();
        hideSearchSuggestions();
        
        // Reload articles without filter
        if (window.location.pathname.includes('index.html') || window.location.pathname === '/') {
            loadArticles(1, null, null);
        }
        
        // Update URL
        const url = new URL(window.location);
        url.searchParams.delete('search');
        window.history.replaceState({}, '', url);
    }
}

function performSearch() {
    const searchInput = document.getElementById('searchInput');
    if (!searchInput) return;
    
    const searchTerm = searchInput.value.trim();
    
    if (!searchTerm) {
        clearSearch();
        return;
    }
    
    // Add to search history
    if (!searchHistory.includes(searchTerm)) {
        searchHistory.unshift(searchTerm);
        if (searchHistory.length > maxHistoryItems) {
            searchHistory.pop();
        }
        localStorage.setItem('searchHistory', JSON.stringify(searchHistory));
    }
    
    hideSearchSuggestions();
    
    if (window.location.pathname.includes('category.html')) {
        // If on category page, redirect to index with search
        window.location.href = `index.html?search=${encodeURIComponent(searchTerm)}`;
    } else {
        // If on index, filter articles
        loadArticles(1, null, searchTerm);
        
        // Update URL
        const url = new URL(window.location);
        url.searchParams.set('search', searchTerm);
        window.history.pushState({}, '', url);
    }
}

// Category cards click handler
function setupCategoryCards() {
    const categoryCards = document.querySelectorAll('.category-card');
    categoryCards.forEach(card => {
        card.addEventListener('click', function() {
            const category = this.dataset.category;
            window.location.href = `category.html?cat=${category}`;
        });
    });
}

// Category page
function loadCategoryPage() {
    const urlParams = new URLSearchParams(window.location.search);
    const category = urlParams.get('cat') || 'all';
    
    const categoryHeader = document.querySelector('.category-header h1');
    if (categoryHeader && category !== 'all') {
        categoryHeader.textContent = categoryNames[category] || 'All Categories';
    }
    
    loadArticles(1, category);
}

// Filter buttons
function setupFilterButtons() {
    const filterButtons = document.querySelectorAll('.filter-btn');
    filterButtons.forEach(btn => {
        btn.addEventListener('click', function() {
            // Remove active class from all buttons
            filterButtons.forEach(b => b.classList.remove('active'));
            // Add active class to clicked button
            this.classList.add('active');
            
            const category = this.dataset.category || 'all';
            
            if (window.location.pathname.includes('category.html')) {
                loadArticles(1, category);
            } else if (window.location.pathname.includes('products.html')) {
                loadProducts(category);
            }
        });
    });
}

// Article detail page
function loadArticleDetail() {
    const articleDetailEl = document.querySelector('.article-detail');
    
    // Add loading indicator
    if (articleDetailEl) {
        articleDetailEl.innerHTML = '<p>Loading article...</p>';
    }
    
    const urlParams = new URLSearchParams(window.location.search);
    const articleSlug = urlParams.get('title');
    
    console.log('loadArticleDetail called, slug:', articleSlug);
    
    if (!articleSlug) {
        if (articleDetailEl) articleDetailEl.innerHTML = '<h1>Article not found</h1><p>No article title specified in URL.</p>';
        return;
    }
    
    // Check if articles array is loaded
    if (typeof articles === 'undefined' || !articles || articles.length === 0) {
        console.error('Articles array not loaded');
        if (articleDetailEl) articleDetailEl.innerHTML = '<h1>Error: Articles data not loaded</h1><p>Please check if data.js is loaded correctly.</p>';
        return;
    }
    
    console.log('Articles loaded:', articles.length, 'articles');
    
    // Find article by matching slug with title
    const article = articles.find(a => {
        const articleTitleSlug = titleToSlug(a.title);
        return articleTitleSlug === decodeURIComponent(articleSlug) || 
               articleTitleSlug === articleSlug;
    });
    
    if (!article) {
        console.log('Article not found. Slug:', articleSlug);
        console.log('Available articles:', articles.map(a => ({ id: a.id, title: a.title, slug: titleToSlug(a.title) })));
        if (articleDetailEl) articleDetailEl.innerHTML = '<h1>Article not found</h1><p>Could not find article with slug: ' + articleSlug + '</p>';
        return;
    }
    
    console.log('Article found:', article.title);
    
    const articleDetail = document.querySelector('.article-detail');
    if (!articleDetail) return;
    
    articleDetail.innerHTML = `
        <div class="article-header">
            <img src="${article.image}" alt="${article.title}" class="article-header-image">
            <div class="article-meta">
                <span>${formatDate(article.date)}</span>
                <span>${categoryNames[article.category]}</span>
            </div>
            <h1 class="article-detail-title">${article.title}</h1>
            <p class="article-intro">${article.excerpt}</p>
        </div>
        <div class="article-body">
            ${article.content}
        </div>
        ${article.products && article.products.length > 0 ? `
        <div class="product-recommendations">
            <h2>Recommended Products</h2>
            <div class="products-grid">
                ${article.products.map(product => {
                    const productLink = product.buyLink || `product.html?name=${encodeURIComponent(titleToSlug(product.name))}`;
                    return `
                    <a href="${productLink}" ${product.buyLink ? 'target="_blank" rel="noopener noreferrer"' : ''} class="product-card">
                        <div class="product-image">
                            <img src="${product.image}" alt="${product.name}">
                        </div>
                        <div class="product-info">
                            <h3 class="product-name">${product.name}</h3>
                            <p class="product-description">${product.description}</p>
                            <div class="product-price">${product.price}</div>
                        </div>
                    </a>
                `;
                }).join('')}
            </div>
        </div>
        ` : ''}
    `;
}

// Generate star rating helper function
function generateStarRating(rating, small = false) {
    if (!rating) return '';
    
    const fullStars = Math.floor(rating);
    const hasHalfStar = rating % 1 >= 0.5;
    const emptyStars = 5 - fullStars - (hasHalfStar ? 1 : 0);
    
    const size = small ? '16px' : '20px';
    
    let starsHTML = '';
    
    // Full stars
    for (let i = 0; i < fullStars; i++) {
        starsHTML += `<svg class="star-icon ${small ? 'star-small' : ''}" viewBox="0 0 24 24" fill="currentColor" style="width: ${size}; height: ${size};">
            <polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"></polygon>
        </svg>`;
    }
    
    // Half star
    if (hasHalfStar) {
        starsHTML += `<svg class="star-icon ${small ? 'star-small' : ''}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="width: ${size}; height: ${size};">
            <defs>
                <linearGradient id="half-fill-${Math.random().toString(36).substr(2, 9)}">
                    <stop offset="50%" stop-color="currentColor"/>
                    <stop offset="50%" stop-color="transparent"/>
                </linearGradient>
            </defs>
            <polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2" fill="url(#half-fill-${Math.random().toString(36).substr(2, 9)})" stroke="currentColor"/>
        </svg>`;
    }
    
    // Empty stars
    for (let i = 0; i < emptyStars; i++) {
        starsHTML += `<svg class="star-icon ${small ? 'star-small' : ''}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="width: ${size}; height: ${size};">
            <polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"></polygon>
        </svg>`;
    }
    
    return `<div class="star-rating">${starsHTML}</div>`;
}

// Products page
function loadProducts(category = 'all') {
    const productsContainer = document.querySelector('.products-container');
    if (!productsContainer) return;
    
    let filteredProducts = category === 'all' 
        ? products 
        : products.filter(p => p.category === category);
    
    productsContainer.innerHTML = filteredProducts.map(product => {
        const starRating = generateStarRating(product.rating || 0, true);
        const productSlug = titleToSlug(product.name);
        return `
        <a href="product.html?name=${encodeURIComponent(productSlug)}" class="product-page-card">
            <div class="product-page-image">
                <img src="${product.image}" alt="${product.name}">
            </div>
            <div class="product-info">
                <h3 class="product-name">${product.name}</h3>
                ${product.rating ? `
                <div class="product-card-rating">
                    ${starRating}
                    <span class="product-card-rating-value">${product.rating}</span>
                    <span class="product-card-rating-count">(${product.reviewCount || 0})</span>
                </div>
                ` : ''}
                <p class="product-description">${product.description}</p>
                <div class="product-price">${product.price}</div>
            </div>
        </a>
    `;
    }).join('');
}

// Product detail page
function loadProductDetail() {
    const urlParams = new URLSearchParams(window.location.search);
    const productSlug = urlParams.get('name');
    
    if (!productSlug) {
        document.querySelector('.product-detail').innerHTML = '<h1>Product not found</h1>';
        return;
    }
    
    // Find product by matching slug with name
    const decodedSlug = decodeURIComponent(productSlug);
    const product = products.find(p => {
        const productNameSlug = titleToSlug(p.name);
        return productNameSlug === decodedSlug || 
               productNameSlug === productSlug ||
               p.name.toLowerCase() === decodedSlug.replace(/-/g, ' ');
    });
    
    if (!product) {
        document.querySelector('.product-detail').innerHTML = '<h1>Product not found</h1>';
        return;
    }
    
    const productDetail = document.querySelector('.product-detail');
    if (!productDetail) return;
    
    // Generate star rating HTML
    const starRating = generateStarRating(product.rating);
    
    // Generate reviews HTML
    const reviewsHTML = product.reviews ? product.reviews.map(review => `
        <div class="product-review-item">
            <div class="review-header">
                <div class="review-author">${review.author}</div>
                <div class="review-date">${formatDate(review.date)}</div>
            </div>
            <div class="review-rating">${generateStarRating(review.rating, true)}</div>
            <div class="review-comment">${review.comment}</div>
        </div>
    `).join('') : '';
    
    // Find related article
    const relatedArticle = product.relatedArticleId ? articles.find(a => a.id === product.relatedArticleId) : null;
    
    productDetail.innerHTML = `
        <div class="product-detail-content">
            <div class="product-detail-image">
                <img src="${product.image}" alt="${product.name}">
            </div>
            <div class="product-detail-info">
                <span class="product-category-badge">${categoryNames[product.category]}</span>
                <h1 class="product-detail-name">${product.name}</h1>
                
                <div class="product-rating-section">
                    <div class="product-rating">
                        ${starRating}
                        <span class="rating-value">${product.rating}</span>
                        <span class="rating-count">(${product.reviewCount} reviews)</span>
                    </div>
                </div>
                
                <p class="product-detail-description">${product.description}</p>
                <div class="product-detail-price">${product.price}</div>
                
                <div class="product-action-buttons">
                    <a href="${product.buyLink}" target="_blank" class="buy-now-btn">
                        <svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                            <circle cx="9" cy="21" r="1"></circle>
                            <circle cx="20" cy="21" r="1"></circle>
                            <path d="M1 1h4l2.68 13.39a2 2 0 0 0 2 1.61h9.72a2 2 0 0 0 2-1.61L23 6H6"></path>
                        </svg>
                        Buy Now
                    </a>
                    ${relatedArticle ? `
                    <a href="article.html?title=${encodeURIComponent(titleToSlug(relatedArticle.title))}" class="read-article-btn">
                        <svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                            <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"></path>
                            <polyline points="14 2 14 8 20 8"></polyline>
                            <line x1="16" y1="13" x2="8" y2="13"></line>
                            <line x1="16" y1="17" x2="8" y2="17"></line>
                        </svg>
                        Read Related Article
                    </a>
                    ` : ''}
                </div>
            </div>
        </div>
        
        ${product.reviews && product.reviews.length > 0 ? `
        <div class="product-reviews-section">
            <h2 class="reviews-section-title">Customer Reviews</h2>
            <div class="product-reviews">
                ${reviewsHTML}
            </div>
        </div>
        ` : ''}
    `;
}


// Check for URL parameters on index page
window.addEventListener('load', function() {
    if (window.location.pathname.includes('index.html') || window.location.pathname === '/') {
        const urlParams = new URLSearchParams(window.location.search);
        const searchTerm = urlParams.get('search');
        const category = urlParams.get('cat');
        
        if (searchTerm) {
            const searchInput = document.getElementById('searchInput');
            if (searchInput) {
                searchInput.value = decodeURIComponent(searchTerm);
            }
            loadArticles(1, category, searchTerm);
        } else if (category) {
            loadArticles(1, category);
        }
    }
});

