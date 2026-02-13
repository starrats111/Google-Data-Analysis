// 文章索引 - 生成于 2026-02-13
// 列表页使用此文件，详情页按需加载 articles/*.json

const articlesIndex = [
  {
    "id": 1,
    "title": "Sustainable Fashion: The Future of Style",
    "slug": "sustainable-fashion-the-future-of-style",
    "category": "fashion",
    "date": "2025-09-15",
    "excerpt": "Discover how sustainable fashion is revolutionizing the industry and learn about eco-friendly brands leading the way.",
    "image": "https://images.unsplash.com/photo-1441986300917-64674bd600d8?w=800",
    "featured": false,
    "hasProducts": true
  },
  {
    "id": 7,
    "title": "Built for the Wild: Explore Badlands' Full Hunting Gear Lineup",
    "slug": "built-for-the-wild-explore-badlands-full-hunting-gear-lineup",
    "category": "travel",
    "date": "2026-01-06",
    "featured": true,
    "excerpt": "From wind‑carved ridgelines to snow‑covered valleys, discover how Badlands' full hunting gear lineup equips you to go deeper, stay longer, and hunt harder.",
    "image": "image/6-1.png",
    "hasProducts": true
  },
  {
    "id": 2,
    "title": "Natural Skincare Routine for Glowing Skin",
    "slug": "natural-skincare-routine-for-glowing-skin",
    "category": "health",
    "date": "2025-10-22",
    "excerpt": "Learn how to create an effective natural skincare routine that will leave your skin glowing and healthy.",
    "image": "https://images.unsplash.com/photo-1556228578-0d85b1a4d571?w=800",
    "featured": false,
    "hasProducts": true
  },
  {
    "id": 3,
    "title": "Modern Minimalist Home Design Ideas",
    "slug": "modern-minimalist-home-design-ideas",
    "category": "home",
    "date": "2025-11-18",
    "excerpt": "Transform your living space with minimalist design principles that create calm, functional, and beautiful environments.",
    "image": "https://images.unsplash.com/photo-1586023492125-27b2c045efd7?w=800",
    "featured": false,
    "hasProducts": true
  },
  {
    "id": 4,
    "title": "Hidden Gems: Unexplored European Destinations",
    "slug": "hidden-gems-unexplored-european-destinations",
    "category": "travel",
    "date": "2025-12-10",
    "excerpt": "Discover breathtaking European destinations that remain off the beaten path, offering authentic experiences away from tourist crowds.",
    "image": "https://images.unsplash.com/photo-1488646953014-85cb44e25828?w=800",
    "featured": false,
    "hasProducts": true
  },
  {
    "id": 5,
    "title": "Smart Financial Planning for Young Professionals",
    "slug": "smart-financial-planning-for-young-professionals",
    "category": "finance",
    "date": "2026-01-08",
    "excerpt": "Essential financial planning strategies to help young professionals build wealth and secure their financial future.",
    "image": "https://images.unsplash.com/photo-1551288049-bebda4e38f71?w=800",
    "featured": false,
    "hasProducts": true
  },
  {
    "id": 6,
    "title": "Artisan Coffee: A Journey Through Flavor Profiles",
    "slug": "artisan-coffee-a-journey-through-flavor-profiles",
    "category": "food",
    "date": "2026-01-25",
    "excerpt": "Explore the world of artisan coffee and discover how different brewing methods and bean origins create unique flavor experiences.",
    "image": "https://images.unsplash.com/photo-1509042239860-f550ce710b93?w=800",
    "featured": false,
    "hasProducts": true
  },
  {
    "id": 8,
    "title": "Why Your Skin Needs Different Care After 40",
    "slug": "why-your-skin-needs-different-care-after-40",
    "category": "health",
    "date": "2026-02-01",
    "featured": true,
    "excerpt": "The skincare products that worked in your twenties and thirties might not cut it anymore. Here's what actually helps mature skin look its best.",
    "image": "image/7-1.png",
    "hasProducts": true
  }
];

// Products Data
const products = [
    {
        id: 1,
        name: "Organic Cotton T-Shirt",
        category: "fashion",
        description: "Premium 100% organic cotton t-shirt, ethically produced with sustainable practices. Soft, breathable, and perfect for everyday wear.",
        price: "$45",
        image: "https://images.unsplash.com/photo-1521572163474-6864f9cf17ab?w=600",
        rating: 4.5,
        reviewCount: 128,
        reviews: [
            { author: "Sarah M.", rating: 5, comment: "Love this shirt! Super soft and comfortable. Great quality for the price.", date: "2025-09-20" },
            { author: "John D.", rating: 4, comment: "Good quality organic cotton. Fits well and feels great.", date: "2025-09-15" },
            { author: "Emma L.", rating: 5, comment: "Perfect fit and very comfortable. Will definitely buy again!", date: "2025-09-10" }
        ],
        buyLink: "https://www.amazon.com/s?k=organic+cotton+t-shirt",
        relatedArticleId: 1
    },
    {
        id: 3,
        name: "Natural Face Cleanser",
        category: "health",
        description: "Gentle daily cleanser with botanical extracts. Removes impurities while maintaining skin's natural balance.",
        price: "$32",
        image: "https://images.unsplash.com/photo-1556229010-6c3f2c9ca5f8?w=600",
        rating: 4.6,
        reviewCount: 203,
        reviews: [
            { author: "Jessica T.", rating: 5, comment: "My skin feels so clean and refreshed after using this. Highly recommend!", date: "2025-10-25" },
            { author: "David W.", rating: 4, comment: "Gentle on sensitive skin. Works well for daily use.", date: "2025-10-20" },
            { author: "Amanda S.", rating: 5, comment: "Best cleanser I've tried. Natural ingredients and great results.", date: "2025-10-15" }
        ],
        buyLink: "https://www.amazon.com/s?k=natural+face+cleanser",
        relatedArticleId: 2
    },
    {
        id: 5,
        name: "Minimalist Coffee Table",
        category: "home",
        description: "Clean lines and natural wood finish. This coffee table combines functionality with minimalist aesthetic.",
        price: "$299",
        image: "https://images.unsplash.com/photo-1532372320572-cda25653a26d?w=600",
        rating: 4.4,
        reviewCount: 76,
        reviews: [
            { author: "Jennifer L.", rating: 5, comment: "Perfect addition to our minimalist living room. Beautiful design!", date: "2025-11-20" },
            { author: "Robert C.", rating: 4, comment: "Good quality and sturdy. Matches our decor perfectly.", date: "2025-11-15" }
        ],
        buyLink: "https://www.amazon.com/s?k=minimalist+coffee+table",
        relatedArticleId: 3
    },
    {
        id: 7,
        name: "Travel Guide: Hidden Europe",
        category: "travel",
        description: "Comprehensive guidebook featuring off-the-beaten-path European destinations with detailed maps and local insights.",
        price: "$24",
        image: "https://images.unsplash.com/photo-1488646953014-85cb44e25828?w=600",
        rating: 4.7,
        reviewCount: 89,
        reviews: [
            { author: "Patricia N.", rating: 5, comment: "Excellent guide! Found amazing hidden gems in Europe.", date: "2025-12-15" },
            { author: "Kevin J.", rating: 4, comment: "Very informative and well-organized. Great travel companion.", date: "2025-12-10" }
        ],
        buyLink: "https://www.amazon.com/s?k=hidden+europe+travel+guide",
        relatedArticleId: 4
    },
    {
        id: 9,
        name: "Financial Planning Workbook",
        category: "finance",
        description: "Step-by-step guide to personal finance with worksheets, templates, and expert advice for building wealth.",
        price: "$19",
        image: "https://images.unsplash.com/photo-1554224155-6726b3ff858f?w=600",
        rating: 4.5,
        reviewCount: 234,
        reviews: [
            { author: "Stephanie G.", rating: 5, comment: "Very helpful workbook. Great for organizing finances!", date: "2026-01-10" },
            { author: "Mark T.", rating: 4, comment: "Practical and easy to follow. Good investment.", date: "2026-01-08" },
            { author: "Laura H.", rating: 5, comment: "Excellent resource for financial planning. Highly recommend!", date: "2026-01-05" }
        ],
        buyLink: "https://www.amazon.com/s?k=financial+planning+workbook",
        relatedArticleId: 5
    },
    {
        id: 11,
        name: "Artisan Coffee Blend",
        category: "food",
        description: "Premium single-origin coffee beans, carefully roasted for rich flavor and smooth finish.",
        price: "$28",
        image: "https://images.unsplash.com/photo-1559056199-641a0ac8b55e?w=600",
        rating: 4.8,
        reviewCount: 198,
        reviews: [
            { author: "James W.", rating: 5, comment: "Best coffee I've ever tasted! Rich and smooth.", date: "2026-01-28" },
            { author: "Susan D.", rating: 5, comment: "Amazing flavor profile. Will order again!", date: "2026-01-25" },
            { author: "Michael B.", rating: 4, comment: "Great quality coffee. Very aromatic and flavorful.", date: "2026-01-22" }
        ],
        buyLink: "https://www.amazon.com/s?k=artisan+coffee+blend",
        relatedArticleId: 6
    },
    {
        id: 13,
        name: "Badlands MRK 4 Big Game Pack",
        category: "travel",
        description: "A dedicated big game hunting pack engineered for hauling serious weight with all‑day comfort, using quiet, durable materials and a layout built for real hunts.",
        price: "$399",
        image: "image/mrk-4.png",
        rating: 4.8,
        reviewCount: 142,
        reviews: [
            { author: "Hunter L.", rating: 5, comment: "Carries weight incredibly well — hiked all day with a full load and my shoulders and hips still felt good.", date: "2026-01-12" },
            { author: "Mark S.", rating: 5, comment: "Attachment points and pocket layout are spot on. Quiet, practical, and easily one of the best hunting packs I've run so far.", date: "2026-01-15" }
        ],
        buyLink: "https://www.badlandsgear.com/collections/big-game/products/mrk-4",
        relatedArticleId: 7
    },
    {
        id: 15,
        name: "Badlands Layered Hunting Apparel System",
        category: "travel",
        description: "A complete three‑layer hunting clothing system that covers moisture‑wicking base layers, warm mid‑layers, and protective outer shells.",
        price: "$459",
        image: "image/6-3.png",
        rating: 4.7,
        reviewCount: 97,
        reviews: [
            { author: "Chen Y.", rating: 5, comment: "Layering is super intuitive — just add or drop pieces as temps swing and you're always in the comfort zone.", date: "2026-01-09" },
            { author: "Alex R.", rating: 4, comment: "Great balance of warmth and breathability. Sat in the snow glassing for hours without getting chilled through.", date: "2026-01-18" }
        ],
        buyLink: "https://www.badlandsgear.com/",
        relatedArticleId: 7
    },
    {
        id: 17,
        name: "Badlands Bino & Gear Harness Kit",
        category: "travel",
        description: "A bino and gear harness system with multiple pockets that keeps your glass, ammo, and small essentials right where you need them.",
        price: "$189",
        image: "image/6-4.png",
        rating: 4.9,
        reviewCount: 121,
        reviews: [
            { author: "Liang Z.", rating: 5, comment: "Everything I need is on my chest — no more digging in the pack and missing moments. Huge boost to real‑world efficiency.", date: "2026-01-20" },
            { author: "Brian K.", rating: 5, comment: "Build quality is excellent and it rides steady. Wore it all day with no hot spots or pressure points.", date: "2026-01-22" }
        ],
        buyLink: "https://www.badlandsgear.com/",
        relatedArticleId: 7
    },
    {
        id: 19,
        name: "Total Package Set",
        category: "health",
        description: "Complete skincare and makeup collection designed for mature skin, addressing wrinkles, dark circles, and loss of firmness. Includes cleanser, serums, moisturizers, and makeup essentials.",
        price: "$357",
        image: "image/p-7-1.png",
        rating: 4.3,
        reviewCount: 4,
        reviews: [
            { author: "Susan M.", rating: 5, comment: "This set has everything I need. My skin looks so much better after just a few weeks!", date: "2026-01-28" },
            { author: "Patricia K.", rating: 4, comment: "Great value for the money. All products work well together.", date: "2026-01-25" }
        ],
        buyLink: "https://www.linkhaitao.com/index.php?mod=lhdeal&track=842dZuyuSe_alynnV_btOuEUONGwxiE13K5IMwifCSaERcNHFExlPgauhFqmuJaJkw2HpTzb_bJCdQg6p4MaOL_a&new=https%3A%2F%2Ffieracosmetics.com%2Fproducts%2Ftotal-package",
        relatedArticleId: 8
    },
    {
        id: 21,
        name: "Morning Essentials",
        category: "health",
        description: "Essential morning routine set with cleanser, serum, and moisturizer to start your day with hydrated, glowing skin. Perfect for mature skin care.",
        price: "$119",
        image: "image/p-7-2.png",
        rating: 4.8,
        reviewCount: 8,
        reviews: [
            { author: "Linda R.", rating: 5, comment: "Love this morning routine! My skin feels so hydrated and looks brighter.", date: "2026-01-30" },
            { author: "Carol T.", rating: 5, comment: "Perfect set for starting the day. Products work beautifully together.", date: "2026-01-27" }
        ],
        buyLink: "https://www.linkhaitao.com/index.php?mod=lhdeal&track=842dZuyuSe_alynnV_btOuEUONGwxiE13K5IMwifCSaERcNHFExlPgauhFqmuJaJkw2HpTzb_bJCdQg6p4MaOL_a&new=https%3A%2F%2Ffieracosmetics.com%2Fproducts%2Ffiera-morning-essentials",
        relatedArticleId: 8
    }
];

// Category mapping
const categoryNames = {
    fashion: "Fashion & Accessories",
    health: "Health & Beauty",
    home: "Home & Garden",
    travel: "Travel & Accommodation",
    finance: "Finance & Insurance",
    food: "Food & Beverage"
};

// 兼容性：为旧代码提供 articles 变量（指向索引）
const articles = articlesIndex;

