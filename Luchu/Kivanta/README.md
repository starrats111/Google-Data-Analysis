# Kivanta - Lifestyle Blog Website

Welcome to Kivanta! This is a minimalist lifestyle blog website covering six categories: Food & Beverage, Fashion & Accessories, Health & Beauty, Home & Garden, Travel & Accommodation, and Finance & Insurance.

## Features

### Design Style
- ✨ **Minimalist** - Generous whitespace, limited colors, clean lines
- 🎨 **Black & White Palette** - Clean and elegant visual experience
- 📱 **Responsive Design** - Perfect support for desktop, tablet, and mobile
- 🎬 **Smooth Animations** - CSS3 transitions and animations enhance UX

### Functionality
- 🔍 **Real-time Search** - Site-wide search to quickly find content
- 📂 **Category Navigation** - 6 main categories for easy browsing
- 📄 **Pagination System** - Optimized content display
- 📱 **Mobile Optimized** - Navigation and layout optimized for small screens
- 🔗 **Social Media** - Integrated links to major platforms
- 📧 **Contact Form** - Easy-to-use contact form

### Content Categories
1. **Food & Beverage** - Food recommendations, drink reviews
2. **Fashion & Accessories** - Style guides, brand recommendations
3. **Health & Beauty** - Skincare reviews, healthy living
4. **Home & Garden** - Interior design, renovation guides
5. **Travel & Accommodation** - Travel guides, hotel recommendations
6. **Finance & Insurance** - Financial planning, insurance knowledge

## Project Structure

```
Kivanta/
├── index.html              # Homepage
├── about.html              # About page
├── contact.html            # Contact page
├── category.html           # Category page
├── article-1.html          # Article 1: Coffee Recommendations
├── article-2.html          # Article 2: Minimalist Style Guide
├── article-3.html          # Article 3: Winter Skincare
├── article-4.html          # Article 4: Nordic Home Design
├── article-5.html          # Article 5: Asian Destinations
├── css/
│   ├── style.css           # Main stylesheet
│   ├── article.css         # Article page styles
│   └── page.css            # Other page styles
├── js/
│   ├── main.js             # Main JavaScript file
│   ├── category.js         # Category page functionality
│   └── contact.js          # Contact form handling
└── README.md               # Project documentation
```

## Tech Stack

- **HTML5** - Semantic markup for SEO and accessibility
- **CSS3** - Modern CSS features including Grid, Flexbox, animations
- **Vanilla JavaScript** - Pure JS, no framework dependencies
- **Font Awesome** - Icon library
- **Unsplash** - High-quality image source

## Articles

### 1. Best Specialty Coffee to Try in 2026
- **Category:** Food & Beverage
- **Date:** January 15, 2026
- **Content:** Explore top coffee beans, brewing techniques, and brand recommendations

### 2. Minimalist Winter Style Guide
- **Category:** Fashion & Accessories
- **Date:** December 20, 2025
- **Content:** Minimalist wardrobe essentials and styling tips

### 3. Essential Winter Skincare Product Reviews
- **Category:** Health & Beauty
- **Date:** November 28, 2025
- **Content:** In-depth reviews of 5 winter skincare products

### 4. 10 Tips for Creating a Nordic-Style Home
- **Category:** Home & Garden
- **Date:** November 10, 2025
- **Content:** Complete guide to Nordic interior design

### 5. Best Asian Destinations to Visit in 2026
- **Category:** Travel & Accommodation
- **Date:** October 25, 2025
- **Content:** 5 must-visit Asian destinations

## Getting Started

### Local Development

1. Clone or download the project
2. Open `index.html` directly in your browser
3. No installation or build tools required

### Deployment

As a pure static website, deploy to any static hosting service:

- **GitHub Pages**
- **Netlify**
- **Vercel**
- **AWS S3**
- **Firebase Hosting**

Simply upload all files to start.

## Browser Support

- ✅ Chrome (recommended)
- ✅ Firefox
- ✅ Safari
- ✅ Edge
- ✅ Opera

Supports all modern browser versions.

## Design Philosophy

### Minimalist Core
- **Whitespace** - Generous whitespace lets content breathe
- **Color** - Limited color palette, primarily black, white, and gray
- **Lines** - Clean, simple lines without excess decoration
- **Focus** - Highlight core content, remove distractions

### User Experience
- **Fast Loading** - Optimized images and code
- **Easy Navigation** - Clear structure for quick content discovery
- **Responsive** - Consistent experience across all devices
- **Accessible** - Follows web accessibility standards

## Customization

### Changing Colors
Modify CSS variables in `:root` at the top of `css/style.css`:

```css
:root {
    --primary-color: #000000;    /* Primary color */
    --secondary-color: #ffffff;   /* Background */
    --text-color: #333333;        /* Text color */
    --light-gray: #f5f5f5;        /* Light gray */
    --border-color: #e0e0e0;      /* Border color */
    --hover-color: #666666;       /* Hover color */
}
```

### Adding New Articles
1. Copy any `article-*.html` file
2. Update article content, title, and date
3. Add article info to arrays in `js/main.js` and `js/category.js`
4. Update homepage article cards

### Updating Social Links
Find social icons in the footer of each HTML file and update the URLs:

```html
<a href="https://twitter.com/your-account" target="_blank">
    <i class="fab fa-twitter"></i>
</a>
```

## Notes

### Images
All images are from Unsplash, a free high-quality image platform. For production:
1. Download images locally for faster loading
2. Use image compression tools
3. Consider WebP format for better performance

### Static Site Features
This is a pure static website:
- ✅ No server-side code required
- ✅ No database needed
- ✅ Simple deployment, low cost
- ⚠️ Contact form needs third-party service (e.g., Formspree, Netlify Forms)
- ⚠️ Search only covers predefined articles

### Future Enhancements
- Integrate third-party form service for contact form
- Add commenting system (e.g., Disqus, Utterances)
- Implement advanced search functionality
- Add RSS feed
- Integrate Google Analytics
- Add dark mode toggle

## Contact

- **Email:** hello@kivanta.com
- **Website:** [Kivanta](#)

## License

© 2026 Kivanta. All rights reserved.

This project is for learning and reference purposes. Contact us for commercial licensing.

---

Thank you for using the Kivanta blog template! Feel free to reach out with questions or feedback.
