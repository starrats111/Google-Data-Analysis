# Zontri - Lifestyle Blog Website

A comprehensive lifestyle blog website featuring six main categories: Fashion & Accessories, Health & Beauty, Home & Garden, Travel & Accommodation, Finance & Insurance, and Food & Beverage.

## Features

- **Modern Art-Inspired Design**: Black, gold, and gray color scheme with gradient backgrounds
- **Six Main Categories**: Comprehensive content across lifestyle topics
- **Article Management**: 5 featured articles with detailed content
- **Product Recommendations**: Product showcase with detailed pages
- **Search Functionality**: Search articles across all categories
- **Category Filtering**: Filter articles and products by category
- **Pagination**: Navigate through articles with pagination controls
- **Responsive Design**: Works on desktop, tablet, and mobile devices
- **Social Media Integration**: Links to Facebook, Twitter, Instagram, and Pinterest

## File Structure

```
Zontri/
├── index.html          # Homepage
├── article.html        # Article detail page
├── category.html       # Category listing page
├── products.html       # Products listing page
├── product.html        # Product detail page
├── about.html          # About page
├── contact.html        # Contact page
├── css/
│   └── style.css       # Main stylesheet
├── js/
│   ├── data.js         # Articles and products data
│   └── main.js         # Main JavaScript functionality
└── README.md           # This file
```

## Pages

### Homepage (index.html)
- Hero section with site title
- Category grid with 6 main categories
- Featured articles grid
- Pagination controls

### Article Pages
- **Article List**: Browse articles by category
- **Article Detail**: Full article content with images and product recommendations

### Product Pages
- **Product List**: Browse all products with category filtering
- **Product Detail**: Detailed product information with images

### Other Pages
- **About**: Information about Zontri and its mission
- **Contact**: Contact form and contact information

## Articles

The website includes 5 featured articles:

1. **Sustainable Fashion: The Future of Style** (September 2025)
   - Category: Fashion & Accessories
   - Topics: Eco-friendly fashion, sustainable brands, fashion trends

2. **Natural Skincare Routine for Glowing Skin** (October 2025)
   - Category: Health & Beauty
   - Topics: Skincare routine, natural ingredients, beauty tips

3. **Modern Minimalist Home Design Ideas** (November 2025)
   - Category: Home & Garden
   - Topics: Minimalist design, home organization, interior design

4. **Hidden Gems: Unexplored European Destinations** (December 2025)
   - Category: Travel & Accommodation
   - Topics: European travel, hidden destinations, travel tips

5. **Smart Financial Planning for Young Professionals** (January 2026)
   - Category: Finance & Insurance
   - Topics: Financial planning, investment, budgeting

## Usage

1. Open `index.html` in a web browser
2. Navigate through categories using the top menu
3. Click on articles to read full content
4. Use the search box to find specific articles
5. Browse products in the products section
6. Use pagination to navigate through multiple pages

## Design Features

- **Color Scheme**: Black (#0a0a0a), Gold (#d4af37), Gray (#2a2a2a)
- **Typography**: Playfair Display (headings) and Montserrat (body)
- **Animations**: Hover effects, transitions, and modern animations
- **Layout**: Grid-based responsive layout
- **Artistic Elements**: Gold borders, gradient backgrounds, artistic frames

## Browser Compatibility

Works on all modern browsers:
- Chrome
- Firefox
- Safari
- Edge

## Notes

- This is a static website (no backend required)
- All images are loaded from Unsplash (external CDN)
- Social media links point to placeholder URLs
- Contact form shows an alert (no actual submission)

## Customization

To add new articles or products, edit `js/data.js`:
- Add new article objects to the `articles` array
- Add new product objects to the `products` array

To modify styles, edit `css/style.css`:
- Color variables are defined in `:root`
- Responsive breakpoints are in the media queries section


