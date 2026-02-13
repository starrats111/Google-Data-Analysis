// Articles data (same as in main.js)
const allArticles = [
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

// Category information
const categories = {
    food: {
        name: "Food & Beverage",
        desc: "Explore the endless charm of food and drinks"
    },
    fashion: {
        name: "Fashion & Accessories",
        desc: "Discover the art of style and accessories"
    },
    beauty: {
        name: "Health & Beauty",
        desc: "Pursue healthy living and beautiful skin"
    },
    home: {
        name: "Home & Garden",
        desc: "Create your ideal home and living space"
    },
    travel: {
        name: "Travel & Accommodation",
        desc: "Explore exciting journeys around the world"
    },
    finance: {
        name: "Finance & Insurance",
        desc: "Financial planning and insurance knowledge"
    }
};

// Get URL parameter
function getUrlParameter(name) {
    const urlParams = new URLSearchParams(window.location.search);
    return urlParams.get(name);
}

// Render article list
function renderArticles(articles) {
    const articlesContainer = document.getElementById('categoryArticles');
    
    if (articles.length === 0) {
        articlesContainer.innerHTML = `
            <div style="grid-column: 1/-1; text-align: center; padding: 80px 20px;">
                <p style="font-size: 18px; color: #999;">No articles found</p>
            </div>
        `;
        return;
    }

    articlesContainer.innerHTML = articles.map(article => `
        <article class="article-card fade-in">
            <a href="${article.url}">
                <div class="card-image">
                    <img src="${article.image}" alt="${article.title}">
                    <span class="category-badge">${article.categoryName}</span>
                </div>
                <div class="card-content">
                    <time class="card-date">${article.date}</time>
                    <h3 class="card-title">${article.title}</h3>
                    <p class="card-excerpt">${article.excerpt}</p>
                </div>
            </a>
        </article>
    `).join('');

    // Add animation
    const cards = articlesContainer.querySelectorAll('.article-card');
    cards.forEach((card, index) => {
        setTimeout(() => {
            card.style.opacity = '1';
            card.style.transform = 'translateY(0)';
        }, index * 100);
    });
}

// Initialize page
function initCategoryPage() {
    const categoryParam = getUrlParameter('cat');
    const categoryTitle = document.getElementById('categoryTitle');
    const categoryDesc = document.getElementById('categoryDesc');
    
    if (categoryParam && categories[categoryParam]) {
        // Show specific category
        categoryTitle.textContent = categories[categoryParam].name;
        categoryDesc.textContent = categories[categoryParam].desc;
        
        const filteredArticles = allArticles.filter(article => 
            article.category === categoryParam
        );
        
        renderArticles(filteredArticles);
    } else {
        // Show all articles
        categoryTitle.textContent = "All Articles";
        categoryDesc.textContent = "Browse our curated lifestyle content";
        renderArticles(allArticles);
    }
}

// Initialize on page load
document.addEventListener('DOMContentLoaded', initCategoryPage);
