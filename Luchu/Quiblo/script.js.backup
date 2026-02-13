// Mobile Menu Toggle
const mobileMenuToggle = document.querySelector('.mobile-menu-toggle');
const navList = document.querySelector('.nav-list');

if (mobileMenuToggle) {
    mobileMenuToggle.addEventListener('click', () => {
        navList.classList.toggle('active');
    });
}

// Close mobile menu when clicking outside
document.addEventListener('click', (e) => {
    if (!e.target.closest('.nav') && !e.target.closest('.mobile-menu-toggle')) {
        navList.classList.remove('active');
    }
});

// Current page tracking
let currentPage = 1;
const postsPerPage = 6;
let filteredPosts = [...blogPosts];
let currentCategory = 'all';

// Initialize
document.addEventListener('DOMContentLoaded', () => {
    // Check if we're on the index page (home page with featured sections)
    if (document.getElementById('featuredArticles')) {
        displayFeaturedArticles();
        displayFeaturedProducts();
    }
    
    // Check if we're on articles page
    if (document.getElementById('blogPosts')) {
        displayPosts();
        setupSearch();
        setupCategoryFilters();
        setupPagination();
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
});

// Display Featured Articles (Home Page)
function displayFeaturedArticles() {
    const featuredArticlesContainer = document.getElementById('featuredArticles');
    if (!featuredArticlesContainer) return;
    
    const featured = blogPosts
        .filter(post => post.featured === true)
        .sort((a, b) => new Date(b.date) - new Date(a.date));
    
    if (featured.length === 0) {
        featuredArticlesContainer.innerHTML = `
            <div style="grid-column: 1 / -1; text-align: center; padding: 60px 20px;">
                <h2 style="color: var(--text-light); margin-bottom: 15px;">No featured articles</h2>
            </div>
        `;
        return;
    }
    
    featuredArticlesContainer.innerHTML = featured.map(post => `
        <article class="blog-card fade-in" onclick="window.location.href='article.html?title=${encodeURIComponent(titleToSlug(post.title))}'">
            <img src="${post.image}" alt="${post.title}" class="blog-card-image" loading="lazy">
            <div class="blog-card-content">
                <span class="blog-card-category">${getCategoryName(post.category)}</span>
                <h3 class="blog-card-title">${post.title}</h3>
                <p class="blog-card-excerpt">${post.excerpt}</p>
                <div class="blog-card-meta">
                    <span class="blog-card-date">
                        <i class="far fa-calendar"></i>
                        ${formatDate(post.date)}
                    </span>
                </div>
            </div>
        </article>
    `).join('');
}

// Display Featured Products (Home Page)
function displayFeaturedProducts() {
    const featuredProductsContainer = document.getElementById('featuredProducts');
    if (!featuredProductsContainer) return;
    
    if (!featuredProducts || featuredProducts.length === 0) {
        featuredProductsContainer.innerHTML = `
            <div style="grid-column: 1 / -1; text-align: center; padding: 60px 20px;">
                <h2 style="color: var(--text-light); margin-bottom: 15px;">No featured products</h2>
            </div>
        `;
        return;
    }
    
    featuredProductsContainer.innerHTML = featuredProducts.map(product => `
        <article class="blog-card fade-in" onclick="window.location.href='product.html?name=${encodeURIComponent(productNameToSlug(product.name))}'">
            <img src="${product.image}" alt="${product.name}" class="blog-card-image" loading="lazy">
            <div class="blog-card-content">
                <span class="blog-card-category">${getCategoryName(product.category)}</span>
                <h3 class="blog-card-title">${product.name}</h3>
                <p class="blog-card-excerpt">${product.description}</p>
                <div class="blog-card-meta">
                    <div style="display: flex; align-items: center; gap: 10px;">
                        <div class="star-rating" style="color: #FFD700;">
                            ${generateStars(product.rating)}
                        </div>
                        <span style="color: var(--text-light); font-size: 0.9rem;">(${product.reviewCount})</span>
                    </div>
                    <span style="color: var(--primary-pink); font-weight: 600; font-size: 1.1rem;">${product.price}</span>
                </div>
            </div>
        </article>
    `).join('');
}

// Generate star rating HTML
function generateStars(rating) {
    const fullStars = Math.floor(rating);
    const hasHalfStar = rating % 1 >= 0.5;
    const emptyStars = 5 - fullStars - (hasHalfStar ? 1 : 0);
    
    let starsHTML = '';
    for (let i = 0; i < fullStars; i++) {
        starsHTML += '<i class="fas fa-star"></i>';
    }
    if (hasHalfStar) {
        starsHTML += '<i class="fas fa-star-half-alt"></i>';
    }
    for (let i = 0; i < emptyStars; i++) {
        starsHTML += '<i class="far fa-star"></i>';
    }
    return starsHTML;
}

// Display Posts
function displayPosts() {
    const blogPostsContainer = document.getElementById('blogPosts');
    if (!blogPostsContainer) return;
    
    const startIndex = (currentPage - 1) * postsPerPage;
    const endIndex = startIndex + postsPerPage;
    const postsToShow = filteredPosts.slice(startIndex, endIndex);
    
    if (postsToShow.length === 0) {
        blogPostsContainer.innerHTML = `
            <div style="grid-column: 1 / -1; text-align: center; padding: 60px 20px;">
                <h2 style="color: var(--text-light); margin-bottom: 15px;">No posts found</h2>
                <p style="color: var(--text-light);">Try adjusting your search or filter criteria.</p>
            </div>
        `;
        return;
    }
    
    blogPostsContainer.innerHTML = postsToShow.map(post => `
        <article class="blog-card fade-in" onclick="window.location.href='article.html?title=${encodeURIComponent(titleToSlug(post.title))}'">
            <img src="${post.image}" alt="${post.title}" class="blog-card-image" loading="lazy">
            <div class="blog-card-content">
                <span class="blog-card-category">${getCategoryName(post.category)}</span>
                <h3 class="blog-card-title">${post.title}</h3>
                <p class="blog-card-excerpt">${post.excerpt}</p>
                <div class="blog-card-meta">
                    <span class="blog-card-date">
                        <i class="far fa-calendar"></i>
                        ${formatDate(post.date)}
                    </span>
                </div>
            </div>
        </article>
    `).join('');
}

// Setup Search
function setupSearch() {
    const searchInput = document.getElementById('searchInput');
    if (!searchInput) return;
    
    let searchTimeout;
    searchInput.addEventListener('input', (e) => {
        clearTimeout(searchTimeout);
        searchTimeout = setTimeout(() => {
            const searchTerm = e.target.value.toLowerCase().trim();
            filterPosts(searchTerm, currentCategory);
        }, 300);
    });
}

// Setup Category Filters
function setupCategoryFilters() {
    const categoryButtons = document.querySelectorAll('.category-btn');
    categoryButtons.forEach(btn => {
        btn.addEventListener('click', () => {
            // Update active state
            categoryButtons.forEach(b => b.classList.remove('active'));
            btn.classList.add('active');
            
            const category = btn.getAttribute('data-category');
            currentCategory = category;
            
            const searchInput = document.getElementById('searchInput');
            const searchTerm = searchInput ? searchInput.value.toLowerCase().trim() : '';
            
            filterPosts(searchTerm, category);
        });
    });
}

// Filter Posts
function filterPosts(searchTerm, category) {
    filteredPosts = blogPosts.filter(post => {
        const matchesSearch = !searchTerm || 
            post.title.toLowerCase().includes(searchTerm) ||
            post.excerpt.toLowerCase().includes(searchTerm) ||
            post.content.toLowerCase().includes(searchTerm);
        
        const matchesCategory = category === 'all' || post.category === category;
        
        return matchesSearch && matchesCategory;
    });
    
    currentPage = 1;
    displayPosts();
    setupPagination();
}

// Setup Pagination
function setupPagination() {
    const paginationContainer = document.getElementById('pagination');
    if (!paginationContainer) return;
    
    const totalPages = Math.ceil(filteredPosts.length / postsPerPage);
    
    if (totalPages <= 1) {
        paginationContainer.innerHTML = '';
        return;
    }
    
    let paginationHTML = '';
    
    // Previous button
    paginationHTML += `
        <button class="pagination-btn" ${currentPage === 1 ? 'disabled' : ''} onclick="changePage(${currentPage - 1})">
            <i class="fas fa-chevron-left"></i> Previous
        </button>
    `;
    
    // Page numbers
    for (let i = 1; i <= totalPages; i++) {
        if (i === 1 || i === totalPages || (i >= currentPage - 1 && i <= currentPage + 1)) {
            paginationHTML += `
                <button class="pagination-btn ${i === currentPage ? 'active' : ''}" onclick="changePage(${i})">
                    ${i}
                </button>
            `;
        } else if (i === currentPage - 2 || i === currentPage + 2) {
            paginationHTML += `<span class="pagination-ellipsis">...</span>`;
        }
    }
    
    // Next button
    paginationHTML += `
        <button class="pagination-btn" ${currentPage === totalPages ? 'disabled' : ''} onclick="changePage(${currentPage + 1})">
            Next <i class="fas fa-chevron-right"></i>
        </button>
    `;
    
    paginationContainer.innerHTML = paginationHTML;
}

// Change Page
function changePage(page) {
    const totalPages = Math.ceil(filteredPosts.length / postsPerPage);
    if (page < 1 || page > totalPages) return;
    
    currentPage = page;
    displayPosts();
    setupPagination();
    
    // Scroll to top of blog posts
    document.getElementById('blogPosts').scrollIntoView({ behavior: 'smooth', block: 'start' });
}

// Get Category Name
function getCategoryName(category) {
    const categories = {
        'fashion': 'Fashion & Accessories',
        'beauty': 'Health & Beauty',
        'home': 'Home & Garden',
        'travel': 'Travel & Accommodation',
        'finance': 'Finance & Insurance',
        'food': 'Food & Beverage'
    };
    return categories[category] || category;
}

// Format Date
function formatDate(dateString) {
    const date = new Date(dateString);
    const options = { year: 'numeric', month: 'long', day: 'numeric' };
    return date.toLocaleDateString('en-US', options);
}

// Convert title to URL-friendly slug
function titleToSlug(title) {
    return title
        .toLowerCase()
        .replace(/[^\w\s-]/g, '') // Remove special characters
        .replace(/\s+/g, '-') // Replace spaces with hyphens
        .replace(/-+/g, '-') // Replace multiple hyphens with single hyphen
        .trim();
}

// Convert product name to URL-friendly slug
function productNameToSlug(name) {
    return name
        .toLowerCase()
        .replace(/[^\w\s-]/g, '') // Remove special characters
        .replace(/\s+/g, '-') // Replace spaces with hyphens
        .replace(/-+/g, '-') // Replace multiple hyphens with single hyphen
        .trim();
}

// Load Article Page
if (window.location.pathname.includes('article.html')) {
    document.addEventListener('DOMContentLoaded', () => {
        loadArticle();
    });
}

function loadArticle() {
    const urlParams = new URLSearchParams(window.location.search);
    const titleSlug = urlParams.get('title');
    
    // Find article by matching slug
    const article = blogPosts.find(post => titleToSlug(post.title) === titleSlug);
    
    if (!article) {
        document.body.innerHTML = `
            <div style="text-align: center; padding: 100px 20px;">
                <h1>Article Not Found</h1>
                <p>The article you're looking for doesn't exist.</p>
                <a href="index.html" class="back-link">Back to Home</a>
            </div>
        `;
        return;
    }
    
    // Update page title
    document.title = `${article.title} - Quiblo`;
    
    // Create article HTML
    const articleHTML = `
        <div class="container">
            <a href="index.html" class="back-link">
                <i class="fas fa-arrow-left"></i> Back to Home
            </a>
            
            <article class="article-header sticky-header">
                <div class="article-header-image">
                    <img src="${article.image}" alt="${article.title}">
                </div>
                <div class="article-header-content">
                    <span class="blog-card-category">${getCategoryName(article.category)}</span>
                    <h1 class="article-title">${article.title}</h1>
                    <div class="article-meta">
                        <span><i class="far fa-calendar"></i> ${formatDate(article.date)}</span>
                        <span><i class="fas fa-tag"></i> ${getCategoryName(article.category)}</span>
                    </div>
                </div>
            </article>
            
            <div class="article-content">
                ${article.content}
            </div>
            
            ${generateRecommendedProducts(article.id)}
        </div>
    `;
    
    // Replace main content
    const mainContent = document.querySelector('.main-content') || document.querySelector('main') || document.body;
    if (mainContent) {
        mainContent.innerHTML = articleHTML;
    }
}

// Generate Recommended Products Section
function generateRecommendedProducts(articleId) {
    const relatedProduct = allProducts.find(p => p.articleId === articleId);
    
    if (!relatedProduct) {
        return '';
    }
    
    return `
        <section class="recommended-products-section">
            <div class="container">
                <h2 class="section-title">Recommended Product</h2>
                <div class="recommended-product-card">
                    <div class="recommended-product-image">
                        <img src="${relatedProduct.image}" alt="${relatedProduct.name}">
                    </div>
                    <div class="recommended-product-info">
                        <span class="blog-card-category">${getCategoryName(relatedProduct.category)}</span>
                        <h3 class="recommended-product-title">${relatedProduct.name}</h3>
                        <div class="recommended-product-rating">
                            <div class="star-rating-large">
                                ${generateStars(relatedProduct.rating)}
                            </div>
                            <span class="rating-number">${relatedProduct.rating}</span>
                            <span class="review-count">(${relatedProduct.reviewCount} reviews)</span>
                        </div>
                        <p class="recommended-product-description">${relatedProduct.description}</p>
                        <div class="recommended-product-price">${relatedProduct.price}</div>
                        <div class="recommended-product-actions">
                            <a href="product.html?name=${encodeURIComponent(productNameToSlug(relatedProduct.name))}" class="view-product-button">
                                <i class="fas fa-eye"></i> View Product Details
                            </a>
                        </div>
                    </div>
                </div>
            </div>
        </section>
    `;
}

// Add smooth animations on scroll
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

// Load Product Page
if (window.location.pathname.includes('product.html')) {
    document.addEventListener('DOMContentLoaded', () => {
        loadProduct();
    });
}

function loadProduct() {
    const urlParams = new URLSearchParams(window.location.search);
    const productNameSlug = urlParams.get('name');
    
    // Find product by matching slug
    const product = allProducts.find(p => productNameToSlug(p.name) === productNameSlug);
    
    if (!product) {
        document.body.innerHTML = `
            <div style="text-align: center; padding: 100px 20px;">
                <h1>Product Not Found</h1>
                <p>The product you're looking for doesn't exist.</p>
                <a href="index.html" class="back-link">Back to Home</a>
            </div>
        `;
        return;
    }
    
    // Update page title
    document.title = `${product.name} - Quiblo`;
    
    // Get associated article
    const article = blogPosts.find(post => post.id === product.articleId);
    
    // Create product HTML
    const productHTML = `
        <div class="container">
            <a href="products.html" class="back-link">
                <i class="fas fa-arrow-left"></i> Back to Products
            </a>
            
            <div class="product-detail-container">
                <div class="product-detail-image">
                    <img src="${product.image}" alt="${product.name}">
                </div>
                
                <div class="product-detail-info">
                    <span class="blog-card-category">${getCategoryName(product.category)}</span>
                    <h1 class="product-detail-title">${product.name}</h1>
                    
                    <div class="product-rating-section">
                        <div class="star-rating-large">
                            ${generateStars(product.rating)}
                        </div>
                        <span class="rating-number">${product.rating}</span>
                        <span class="review-count">(${product.reviewCount} reviews)</span>
                    </div>
                    
                    <div class="product-price-large">
                        ${product.price}
                    </div>
                    
                    <div class="product-description">
                        <h3>Description</h3>
                        <p>${product.description}</p>
                    </div>
                    
                    <div class="product-actions">
                        <a href="${product.buyLink}" target="_blank" class="buy-button">
                            <i class="fas fa-shopping-cart"></i> Buy Now
                        </a>
                        ${article ? `<a href="article.html?title=${encodeURIComponent(titleToSlug(article.title))}" class="read-article-button">
                            <i class="fas fa-book-open"></i> Read Article
                        </a>` : ''}
                    </div>
                </div>
            </div>
            
            <div class="product-reviews-section">
                <h2>Customer Reviews</h2>
                <div class="reviews-summary">
                    <div class="overall-rating">
                        <div class="rating-circle">
                            <span class="rating-big">${product.rating}</span>
                            <div class="star-rating-large" style="font-size: 1.2rem; margin-top: 10px;">
                                ${generateStars(product.rating)}
                            </div>
                        </div>
                        <p>Based on ${product.reviewCount} reviews</p>
                    </div>
                </div>
                
                <div class="reviews-list">
                    ${product.reviews.map(review => `
                        <div class="review-item">
                            <div class="review-header">
                                <div class="review-author">
                                    <strong>${review.author}</strong>
                                    <div class="star-rating-small">
                                        ${generateStars(review.rating)}
                                    </div>
                                </div>
                                <span class="review-date">${formatDate(review.date)}</span>
                            </div>
                            <p class="review-comment">${review.comment}</p>
                        </div>
                    `).join('')}
                </div>
            </div>
        </div>
    `;
    
    // Replace main content
    const mainContent = document.querySelector('.main-content') || document.querySelector('main') || document.body;
    if (mainContent) {
        mainContent.innerHTML = productHTML;
    }
}

// Observe blog cards
document.addEventListener('DOMContentLoaded', () => {
    const cards = document.querySelectorAll('.blog-card');
    cards.forEach(card => {
        card.style.opacity = '0';
        card.style.transform = 'translateY(20px)';
        card.style.transition = 'opacity 0.6s ease, transform 0.6s ease';
        observer.observe(card);
    });
});

