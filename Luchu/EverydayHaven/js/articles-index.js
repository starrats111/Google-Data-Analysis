// 文章索引 - 生成于 2026-02-13T00:27:07.691Z
// 列表页使用此文件，详情页按需加载 articles/*.json

const articlesIndex = [
  {
    "id": 1,
    "title": "Sustainable Fashion: The Future of Wardrobe Essentials",
    "category": "fashion",
    "date": "2025-01-15",
    "image": "https://images.unsplash.com/photo-1441986300917-64674bd600d8?w=800&h=600&fit=crop",
    "excerpt": "Discover how sustainable fashion is revolutionizing the way we think about our wardrobes. From eco-friendly materials to ethical production practices, learn how to build a conscious closet that doesn't compromise on style.",
    "author": "Sarah Mitchell",
    "hasProducts": true
  },
  {
    "id": 2,
    "title": "The Ultimate Skincare Routine for Glowing Skin",
    "category": "health",
    "date": "2025-03-22",
    "image": "https://images.unsplash.com/photo-1556228578-0d85b1a4d571?w=800&h=600&fit=crop",
    "excerpt": "Unlock the secrets to radiant, healthy skin with our comprehensive guide to building the perfect skincare routine. Learn about the essential steps, key ingredients, and professional tips for achieving that coveted glow.",
    "author": "Dr. Emily Chen",
    "hasProducts": true
  },
  {
    "id": 3,
    "title": "Creating Your Perfect Indoor Garden Oasis",
    "category": "home",
    "date": "2025-05-10",
    "image": "https://images.unsplash.com/photo-1416879595882-3373a0480b5b?w=800&h=600&fit=crop",
    "excerpt": "Transform your living space into a green sanctuary with our expert guide to indoor gardening. Learn how to select the right plants, create optimal growing conditions, and design a beautiful indoor garden that thrives year-round.",
    "author": "James Anderson",
    "hasProducts": true
  },
  {
    "id": 4,
    "title": "Hidden Gems: Budget-Friendly European Destinations",
    "category": "travel",
    "date": "2025-07-08",
    "image": "https://images.unsplash.com/photo-1469854523086-cc02fe5d8800?w=800&h=600&fit=crop",
    "excerpt": "Explore Europe without breaking the bank. Discover charming destinations that offer incredible experiences, rich culture, and stunning scenery at a fraction of the cost of popular tourist hotspots.",
    "author": "Maria Rodriguez",
    "hasProducts": true
  },
  {
    "id": 5,
    "title": "Smart Financial Planning for Your Future",
    "category": "finance",
    "date": "2025-08-20",
    "image": "https://images.unsplash.com/photo-1554224155-6726b3ff858f?w=800&h=600&fit=crop",
    "excerpt": "Take control of your financial future with our comprehensive guide to smart financial planning. Learn essential strategies for budgeting, saving, investing, and building long-term wealth that will secure your financial independence.",
    "author": "Robert Thompson",
    "hasProducts": true
  }
];

// Category mapping
const categoryNames = {
  "fashion": "Fashion & Accessories",
  "health": "Health & Beauty",
  "home": "Home & Garden",
  "travel": "Travel & Accommodation",
  "finance": "Finance & Insurance",
  "food": "Food & Beverage"
};

// Signal that articles-index.js has loaded
window.articlesDataLoaded = true;
