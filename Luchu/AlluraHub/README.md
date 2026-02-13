# AlluraHub - A Curated Lifestyle Blog

A beautifully designed, vintage-inspired lifestyle blog website featuring six main categories: Fashion & Accessories, Health & Beauty, Home & Garden, Travel & Accommodation, Finance & Insurance, and Food & Beverage.

## Features

- **Vintage/Classical Design**: Retro-inspired aesthetic with elegant typography, warm color palette, and paper-textured backgrounds
- **Six Main Categories**: Comprehensive coverage of lifestyle topics
- **Article Management**: 5 detailed blog articles with dates from January to August 2025
- **Search Functionality**: Search articles by title, excerpt, or content
- **Category Filtering**: Browse articles by category
- **Pagination**: Easy navigation through article collections
- **Product Recommendations**: Each article includes curated product recommendations
- **Responsive Design**: Works beautifully on desktop, tablet, and mobile devices
- **Static Website**: Pure HTML, CSS, and JavaScript - no server required

## Project Structure

```
AlluraHub/
├── index.html          # Homepage
├── category.html       # Category listing page
├── article-1.html      # Article detail pages (1-5)
├── article-2.html
├── article-3.html
├── article-4.html
├── article-5.html
├── about.html          # About page
├── contact.html        # Contact page
├── css/
│   └── style.css       # Main stylesheet
├── js/
│   ├── data.js         # Articles data
│   └── main.js         # Main JavaScript functionality
└── README.md
```

## Articles Included

1. **Timeless Elegance: The Art of Vintage Fashion Curation** (January 15, 2025)
   - Category: Fashion & Accessories
   - Topics: Vintage fashion, wardrobe curation, sustainable style

2. **Natural Skincare Rituals: Embracing Botanical Beauty** (March 22, 2025)
   - Category: Health & Beauty
   - Topics: Natural skincare, botanical ingredients, beauty routines

3. **Creating a Cozy Reading Nook: A Sanctuary for the Mind** (May 10, 2025)
   - Category: Home & Garden
   - Topics: Home design, reading spaces, interior decoration

4. **Hidden Gems: Discovering Authentic European Villages** (June 18, 2025)
   - Category: Travel & Accommodation
   - Topics: European travel, village tourism, authentic experiences

5. **Artisanal Coffee Culture: From Bean to Cup** (August 5, 2025)
   - Category: Food & Beverage
   - Topics: Specialty coffee, brewing methods, coffee culture

## Design Features

- **Typography**: 
  - Playfair Display (serif) for headings
  - Crimson Text (serif) for body text
  - Dancing Script (handwritten) for navigation

- **Color Palette**:
  - Primary background: #f5f1e8 (warm beige)
  - Paper background: #faf8f3 (cream)
  - Accent brown: #8b6f47
  - Accent blue: #3d4a5c
  - Text: #2c2416 (dark brown)

- **Visual Effects**:
  - Paper texture background
  - Hover animations on cards and buttons
  - Smooth transitions
  - Vintage-style image filters

## Usage

1. **View the Website**: Simply open `index.html` in a web browser
2. **Navigate Categories**: Click on category links in the navigation menu
3. **Search Articles**: Use the search box in the header
4. **Read Articles**: Click on any article card to view the full article
5. **Browse Products**: Scroll to the bottom of article pages to see product recommendations

## Browser Compatibility

- Chrome (latest)
- Firefox (latest)
- Safari (latest)
- Edge (latest)

## Customization

### Adding New Articles

Edit `js/data.js` and add a new article object to the `articles` array:

```javascript
{
    id: 6,
    title: "Your Article Title",
    category: "fashion", // or health, home, travel, finance, food
    date: "2025-09-15",
    excerpt: "Brief description...",
    image: "image-url",
    content: "<p>Full article content in HTML...</p>",
    products: [
        {
            name: "Product Name",
            description: "Product description",
            price: "$XX",
            image: "product-image-url"
        }
    ]
}
```

### Modifying Styles

Edit `css/style.css` to customize colors, fonts, spacing, and other design elements.

### Changing Categories

Update the `categoryNames` object in `js/data.js` to modify category labels.

## Notes

- All images are loaded from Unsplash (external URLs)
- The website is fully static and can be hosted on any web server
- No database or backend required
- All functionality is client-side JavaScript

## License

This project is created for demonstration purposes. Feel free to use and modify as needed.



