// ==========================================
// Articles Data
// ==========================================
const articles = [
    {
        id: 1,
        title: "Best Specialty Coffee to Try in 2026",
        category: "food",
        categoryName: "Food & Beverage",
        date: "January 15, 2026",
        excerpt: "Explore premium coffee beans from around the world and discover the story behind every cup...",
        url: "best-specialty-coffee-to-try-in-2026.html",
        image: "https://images.unsplash.com/photo-1495474472287-4d71bcdd2085?w=800&q=80"
    },
    {
        id: 2,
        title: "Minimalist Winter Style Guide",
        category: "fashion",
        categoryName: "Fashion & Accessories",
        date: "December 20, 2025",
        excerpt: "Less is more – build your own minimalist wardrobe...",
        url: "minimalist-winter-style-guide.html",
        image: "https://images.unsplash.com/photo-1490481651871-ab68de25d43d?w=800&q=80"
    },
    {
        id: 3,
        title: "Essential Winter Skincare Product Reviews",
        category: "beauty",
        categoryName: "Health & Beauty",
        date: "November 28, 2025",
        excerpt: "In-depth reviews of five popular moisturizing serums to find your perfect match...",
        url: "essential-winter-skincare-product-reviews.html",
        image: "https://images.unsplash.com/photo-1556228578-0d85b1a4d571?w=800&q=80"
    },
    {
        id: 4,
        title: "10 Tips for Creating a Nordic-Style Home",
        category: "home",
        categoryName: "Home & Garden",
        date: "November 10, 2025",
        excerpt: "A complete guide from color schemes to furniture selection...",
        url: "10-tips-for-creating-a-nordic-style-home.html",
        image: "https://images.unsplash.com/photo-1616486338812-3dadae4b4ace?w=800&q=80"
    },
    {
        id: 5,
        title: "Best Asian Destinations to Visit in 2026",
        category: "travel",
        categoryName: "Travel & Accommodation",
        date: "October 25, 2025",
        excerpt: "Discover hidden paradises and plan your next adventure...",
        url: "best-asian-destinations-to-visit-in-2026.html",
        image: "https://images.unsplash.com/photo-1436491865332-7a61a109cc05?w=800&q=80"
    },
    {
        id: 6,
        title: "Rise Pro Apparel: Your New Silent Partner in the Field",
        category: "fashion",
        categoryName: "Fashion & Accessories",
        date: "January 5, 2026",
        excerpt: "Build a quiet, weather-ready hunting apparel system that works as your silent partner in the field.",
        url: "rise-pro-apparel-your-new-silent-partner-in-the-field.html",
        image: "image/2-1.png"
    }
];

// ==========================================
// Mobile Menu Toggle
// ==========================================
const mobileMenuToggle = document.querySelector('.mobile-menu-toggle');
const navMenu = document.querySelector('.nav-menu');

if (mobileMenuToggle) {
    mobileMenuToggle.addEventListener('click', () => {
        navMenu.classList.toggle('active');
        mobileMenuToggle.classList.toggle('active');
    });
}

// Mobile dropdown menu
const dropdowns = document.querySelectorAll('.dropdown');
dropdowns.forEach(dropdown => {
    const toggle = dropdown.querySelector('.dropdown-toggle');
    if (toggle && window.innerWidth <= 768) {
        toggle.addEventListener('click', (e) => {
            e.preventDefault();
            dropdown.classList.toggle('active');
        });
    }
});

// ==========================================
// Search Functionality
// ==========================================
const searchIcon = document.querySelector('.search-icon');
const searchWrapper = document.querySelector('.search-wrapper');
const searchPanel = document.querySelector('.search-panel');
const searchClose = document.querySelector('.search-close');
const searchInput = document.getElementById('searchInput');
const searchResults = document.getElementById('searchResults');

let searchTimeout;

// Toggle search panel
if (searchIcon && searchPanel) {
    searchIcon.addEventListener('click', (e) => {
        e.stopPropagation();
        const isActive = searchPanel.classList.contains('active');
        
        if (!isActive) {
            searchPanel.classList.add('active');
            setTimeout(() => {
                searchInput.focus();
            }, 100);
        } else {
            searchInput.focus();
        }
    });
}

// Close search panel
function closeSearch() {
    const panel = document.querySelector('.search-panel');
    const input = document.getElementById('searchInput');
    const results = document.getElementById('searchResults');
    
    if (panel) {
        panel.classList.remove('active');
    }
    if (input) {
        input.value = '';
    }
    if (results) {
        results.innerHTML = '';
    }
}

// Make closeSearch globally accessible
window.closeSearch = closeSearch;

if (searchClose) {
    searchClose.addEventListener('click', (e) => {
        e.stopPropagation();
        closeSearch();
    });
}

// Close search when clicking outside
document.addEventListener('click', (e) => {
    if (searchWrapper && !searchWrapper.contains(e.target) && searchPanel && searchPanel.classList.contains('active')) {
        closeSearch();
    }
});

// Search input event with debounce
if (searchInput) {
    searchInput.addEventListener('input', (e) => {
        clearTimeout(searchTimeout);
        
        const query = e.target.value.toLowerCase().trim();
        
        searchTimeout = setTimeout(() => {
            if (query.length < 2) {
                if (searchResults) {
                    searchResults.innerHTML = '';
                }
                return;
            }

            const results = articles.filter(article => 
                article.title.toLowerCase().includes(query) ||
                article.excerpt.toLowerCase().includes(query) ||
                article.categoryName.toLowerCase().includes(query)
            );

            displaySearchResults(results);
        }, 200);
    });

    // Prevent search panel from closing when clicking inside
    searchInput.addEventListener('click', (e) => {
        e.stopPropagation();
    });
}

function displaySearchResults(results) {
    if (!searchResults) return;
    
    if (results.length === 0) {
        searchResults.innerHTML = '<div class="search-empty">No articles found</div>';
        return;
    }

    searchResults.innerHTML = results.map(article => `
        <a href="${article.url}" class="search-result-item" onclick="closeSearch()">
            <h4>${article.title}</h4>
            <p>${article.excerpt}</p>
            <span>${article.categoryName} • ${article.date}</span>
        </a>
    `).join('');
}

// ==========================================
// Scroll Animation
// ==========================================
const observerOptions = {
    threshold: 0.1,
    rootMargin: '0px 0px -50px 0px'
};

const observer = new IntersectionObserver((entries) => {
    entries.forEach(entry => {
        if (entry.isIntersecting) {
            entry.target.classList.add('fade-in');
            observer.unobserve(entry.target);
        }
    });
}, observerOptions);

// Observe all card elements
document.addEventListener('DOMContentLoaded', () => {
    const cards = document.querySelectorAll('.featured-card, .article-card, .category-item');
    cards.forEach(card => {
        observer.observe(card);
    });
});

// ==========================================
// Header Scroll Effect
// ==========================================
let lastScroll = 0;
const header = document.querySelector('.header');

window.addEventListener('scroll', () => {
    const currentScroll = window.pageYOffset;

    if (currentScroll > 100) {
        header.style.boxShadow = '0 2px 10px rgba(0,0,0,0.05)';
    } else {
        header.style.boxShadow = 'none';
    }

    lastScroll = currentScroll;
});

// ==========================================
// Smooth Scroll
// ==========================================
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

// ==========================================
// ESC Key to Close Search Panel
// ==========================================
document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && searchPanel && searchPanel.classList.contains('active')) {
        closeSearch();
    }
});

// ==========================================
// Pagination (Removed - only 5 articles)
// ==========================================
// Pagination functionality removed as the site currently has only 5 articles
// If more articles are added in the future, pagination can be re-implemented
