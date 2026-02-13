# VitaHaven - Lifestyle Blog Website

A beautiful, modern lifestyle blog website featuring articles across six categories: Fashion & Accessories, Health & Beauty, Home & Garden, Travel & Accommodation, Finance & Insurance, and Food & Beverage.

## Features

- **Beautiful Design**: Soft, sweet aesthetic with Morandi color palette, rounded corners, and gentle animations
- **6 Main Categories**: Comprehensive coverage of lifestyle topics
- **5 Featured Articles**: Detailed blog posts with images and product recommendations
- **Search Functionality**: Search across all articles and content
- **Category Filtering**: Browse articles by category
- **Pagination**: Easy navigation through article listings
- **Responsive Design**: Fully optimized for mobile, tablet, and desktop
- **Article Detail Pages**: Individual pages for each article with full content
- **Product Recommendations**: Curated product suggestions within articles
- **Contact & About Pages**: Complete information pages
- **Social Media Integration**: Social media links in footer
- **Smooth Animations**: Elegant transitions and hover effects

## File Structure

```
VitaHaven/
├── index.html          # Homepage
├── article.html        # Article detail page template
├── category.html       # Category listing page
├── about.html          # About page
├── contact.html        # Contact page
├── css/
│   └── style.css       # Main stylesheet
├── js/
│   ├── data.js         # Articles and data
│   └── main.js         # Main JavaScript functionality
└── README.md           # This file
```

## Design Philosophy

The website features a **soft, sweet aesthetic** with:
- **Low-saturation colors** (Morandi palette): Soft greens, muted pinks, warm beiges
- **Rounded corners**: Gentle, friendly appearance
- **Smooth animations**: Subtle transitions and hover effects
- **Warm, comfortable feeling**: Inviting and approachable design

## Usage

Simply open `index.html` in a web browser. All pages are static HTML files that work without a server.

### Navigation

- **Home**: Browse all articles with pagination
- **Categories**: Filter articles by category
- **Search**: Use the search icon to find specific content
- **About**: Learn more about VitaHaven
- **Contact**: Get in touch via the contact form

## Articles Included

1. **Sustainable Fashion: 5 Eco-Friendly Brands to Watch in 2025** (January 2025)
   - Category: Fashion & Accessories
   - Features product recommendations for sustainable clothing

2. **The Ultimate Skincare Routine for Glowing Skin in 2025** (March 2025)
   - Category: Health & Beauty
   - Includes skincare product recommendations

3. **Creating a Cozy Home: Minimalist Interior Design Tips** (May 2025)
   - Category: Home & Garden
   - Features home decor product suggestions

4. **Hidden Gems: 5 Underrated European Destinations for 2025** (June 2025)
   - Category: Travel & Accommodation
   - Includes travel product recommendations

5. **Smart Financial Planning: Building Wealth in Your 30s** (August 2025)
   - Category: Finance & Insurance
   - Features financial planning resources

## Customization

### Adding New Articles

Edit `js/data.js` and add new article objects to the `articles` array. Each article should include:
- `id`: Unique identifier
- `title`: Article title
- `category`: Category key (fashion, health, home, travel, finance, food)
- `categoryName`: Full category name
- `date`: Publication date (YYYY-MM-DD)
- `excerpt`: Short description
- `image`: Image URL
- `content`: Full HTML content
- `products`: Array of recommended products (optional)

### Changing Colors

Modify the CSS variables in `css/style.css`:
```css
:root {
    --color-primary: #A8B5A0;
    --color-secondary: #C4A5A5;
    --color-accent: #D4C4B0;
    /* ... */
}
```

### Adding Social Media Links

Update the social media links in the footer section of each HTML file.

## Browser Support

- Chrome (latest)
- Firefox (latest)
- Safari (latest)
- Edge (latest)
- Mobile browsers (iOS Safari, Chrome Mobile)

## Notes

- All images are loaded from Unsplash (external URLs)
- The website is fully static and requires no backend
- All functionality is client-side JavaScript
- No build process required - just open and use!

## License

This project is created for demonstration purposes.


