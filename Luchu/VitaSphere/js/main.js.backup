// Main JavaScript functionality

// Convert title to URL-friendly slug
function titleToSlug(title) {
    return title
        .toLowerCase()
        .trim()
        .replace(/[^\w\s-]/g, '') // Remove special characters
        .replace(/[\s_-]+/g, '-') // Replace spaces and underscores with hyphens
        .replace(/^-+|-+$/g, ''); // Remove leading/trailing hyphens
}

// Initialize on page load
document.addEventListener('DOMContentLoaded', function() {
    initializePage();
    setupEventListeners();
});

// Initialize page based on current URL
function initializePage() {
    const path = window.location.pathname;
    const params = new URLSearchParams(window.location.search);
    const category = params.get('category');
    const search = params.get('search');
    
    if (path.includes('article') || path.includes('article.html')) {
        const slug = params.get('slug');
        if (slug) {
            displayArticle(slug);
        }
    } else if (path.includes('about.html') || path.includes('contact.html')) {
        // Static pages, no special initialization needed
        return;
    } else {
        // Home page
        displayArticles(category, search);
    }
}

// Setup event listeners
function setupEventListeners() {
    // Mobile menu toggle
    const mobileMenuToggle = document.querySelector('.mobile-menu-toggle');
    const mainNav = document.querySelector('.main-nav');
    
    if (mobileMenuToggle) {
        mobileMenuToggle.addEventListener('click', function() {
            mainNav.classList.toggle('active');
        });
    }
    
    // Search functionality
    const searchInput = document.getElementById('searchInput');
    const searchBtn = document.getElementById('searchBtn');
    
    if (searchInput && searchBtn) {
        searchBtn.addEventListener('click', performSearch);
        searchInput.addEventListener('keypress', function(e) {
            if (e.key === 'Enter') {
                performSearch();
            }
        });
    }
    
    // Category filters
    const categoryCards = document.querySelectorAll('.category-card');
    categoryCards.forEach(card => {
        card.addEventListener('click', function(e) {
            e.preventDefault();
            const category = this.dataset.category;
            filterByCategory(category);
        });
    });
    
    // Contact form submission
    const contactForm = document.getElementById('contactForm');
    if (contactForm) {
        contactForm.addEventListener('submit', handleContactSubmit);
    }
}

// Display featured article
function displayFeaturedArticle() {
    const featuredContent = document.getElementById('featuredContent');
    if (!featuredContent) return;
    
    const featured = blogArticles[0]; // Use first article as featured
    const categoryName = categoryNames[featured.category] || featured.category;
    
    featuredContent.innerHTML = `
        <div class="featured-card fade-in">
            <img src="${featured.image}" alt="${featured.title}" class="featured-image">
            <div class="featured-content">
                <div class="featured-category">${categoryName}</div>
                <h2 class="featured-title">${featured.title}</h2>
                <p class="featured-excerpt">${featured.excerpt}</p>
                <div class="featured-meta">
                    <span>${formatDate(featured.date)}</span>
                    <span>By ${featured.author}</span>
                </div>
                <a href="article.html?slug=${encodeURIComponent(titleToSlug(featured.title))}" class="read-more">Read More</a>
            </div>
        </div>
    `;
}

// Display articles with pagination
let currentPage = 1;
const articlesPerPage = 6;

function displayArticles(category = null, search = null) {
    const articlesGrid = document.getElementById('articlesGrid');
    const pagination = document.getElementById('pagination');
    
    if (!articlesGrid) return;
    
    // Filter articles
    let filteredArticles = blogArticles;
    
    if (category) {
        filteredArticles = filteredArticles.filter(article => article.category === category);
    }
    
    if (search) {
        const searchLower = search.toLowerCase();
        filteredArticles = filteredArticles.filter(article => 
            article.title.toLowerCase().includes(searchLower) ||
            article.excerpt.toLowerCase().includes(searchLower) ||
            article.content.toLowerCase().includes(searchLower)
        );
    }
    
    // Calculate pagination
    const totalPages = Math.ceil(filteredArticles.length / articlesPerPage);
    const startIndex = (currentPage - 1) * articlesPerPage;
    const endIndex = startIndex + articlesPerPage;
    const paginatedArticles = filteredArticles.slice(startIndex, endIndex);
    
    // Display articles
    if (paginatedArticles.length === 0) {
        articlesGrid.innerHTML = '<p style="text-align: center; grid-column: 1/-1; padding: 2rem;">No articles found.</p>';
    } else {
        articlesGrid.innerHTML = paginatedArticles.map(article => {
            const categoryName = categoryNames[article.category] || article.category;
            return `
                <a href="article.html?slug=${encodeURIComponent(titleToSlug(article.title))}" class="article-card fade-in">
                    <img src="${article.image}" alt="${article.title}" class="article-image">
                    <div class="article-content">
                        <div class="article-category">${categoryName}</div>
                        <h3 class="article-title">${article.title}</h3>
                        <p class="article-excerpt">${article.excerpt}</p>
                        <div class="article-meta">
                            <span>${formatDate(article.date)}</span>
                            <span>By ${article.author}</span>
                        </div>
                    </div>
                </a>
            `;
        }).join('');
    }
    
    // Display pagination
    if (pagination && totalPages > 1) {
        pagination.innerHTML = '';
        
        // Previous button
        const prevBtn = document.createElement('button');
        prevBtn.textContent = 'Previous';
        prevBtn.disabled = currentPage === 1;
        prevBtn.addEventListener('click', () => {
            currentPage--;
            displayArticles(category, search);
            window.scrollTo({ top: 0, behavior: 'smooth' });
        });
        pagination.appendChild(prevBtn);
        
        // Page numbers
        for (let i = 1; i <= totalPages; i++) {
            const pageBtn = document.createElement('button');
            pageBtn.textContent = i;
            pageBtn.className = i === currentPage ? 'active' : '';
            pageBtn.addEventListener('click', () => {
                currentPage = i;
                displayArticles(category, search);
                window.scrollTo({ top: 0, behavior: 'smooth' });
            });
            pagination.appendChild(pageBtn);
        }
        
        // Next button
        const nextBtn = document.createElement('button');
        nextBtn.textContent = 'Next';
        nextBtn.disabled = currentPage === totalPages;
        nextBtn.addEventListener('click', () => {
            currentPage++;
            displayArticles(category, search);
            window.scrollTo({ top: 0, behavior: 'smooth' });
        });
        pagination.appendChild(nextBtn);
    } else if (pagination) {
        pagination.innerHTML = '';
    }
}

// Display single article
function displayArticle(slug) {
    // URLSearchParams.get() already decodes the parameter, so slug is already decoded
    // Normalize slug: remove any leading/trailing whitespace
    const normalizedSlug = slug.trim();
    
    // Find article by matching slug
    const article = blogArticles.find(a => {
        const articleSlug = titleToSlug(a.title);
        return articleSlug === normalizedSlug;
    });
    
    if (!article) {
        console.error('Article not found for slug:', normalizedSlug);
        console.log('Available slugs:', blogArticles.map(a => titleToSlug(a.title)));
        const mainContent = document.getElementById('articleContent') || document.querySelector('main') || document.body;
        mainContent.innerHTML = '<div class="container" style="padding: 3rem; text-align: center;"><h1>Article not found</h1><p>The article you are looking for could not be found.</p><a href="index.html" style="color: var(--primary-color); text-decoration: underline;">Return to home</a></div>';
        return;
    }
    
    const categoryName = categoryNames[article.category] || article.category;
    
    // Update page title
    document.title = `${article.title} - VitaSphere`;
    
    // Create article page content
    const mainContent = document.getElementById('articleContent') || document.querySelector('main') || document.body;
    mainContent.innerHTML = `
        <article class="article-page">
            <div class="container">
                <div class="article-header">
                    <div class="article-category">${categoryName}</div>
                    <h1 class="article-title">${article.title}</h1>
                    <div class="article-meta">
                        <span>${formatDate(article.date)}</span>
                        <span>By ${article.author}</span>
                    </div>
                </div>
                <div class="article-body">
                    <img src="${article.image}" alt="${article.title}">
                    ${article.content}
                </div>
            </div>
        </article>
    `;
}

// Display products
function displayProducts(category = null) {
    const productGrid = document.querySelector('.product-grid');
    if (!productGrid) return;
    
    let filteredProducts = products;
    if (category) {
        filteredProducts = products.filter(product => product.category === category);
    }
    
    if (filteredProducts.length === 0) {
        productGrid.innerHTML = '<p style="text-align: center; grid-column: 1/-1; padding: 2rem;">No products found.</p>';
    } else {
        productGrid.innerHTML = filteredProducts.map(product => {
            const categoryName = categoryNames[product.category] || product.category;
            return `
                <div class="product-card fade-in">
                    <img src="${product.image}" alt="${product.name}" class="product-image">
                    <div class="product-info">
                        <div class="product-category">${categoryName}</div>
                        <h3 class="product-name">${product.name}</h3>
                        <p class="product-description">${product.description}</p>
                        <div class="product-rating">Rating: ${product.rating}</div>
                    </div>
                </div>
            `;
        }).join('');
    }
}

// Search functionality
function performSearch() {
    const searchInput = document.getElementById('searchInput');
    const query = searchInput.value.trim();
    
    if (query) {
        window.location.href = `index.html?search=${encodeURIComponent(query)}`;
    } else {
        window.location.href = 'index.html';
    }
}

// Filter by category
function filterByCategory(category) {
    currentPage = 1;
    window.location.href = `index.html?category=${category}`;
}

// Format date
function formatDate(dateString) {
    const date = new Date(dateString);
    const options = { year: 'numeric', month: 'long', day: 'numeric' };
    return date.toLocaleDateString('en-US', options);
}

// Handle contact form submission
function handleContactSubmit(e) {
    e.preventDefault();
    alert('Thank you for your message! We will get back to you soon.');
    e.target.reset();
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

