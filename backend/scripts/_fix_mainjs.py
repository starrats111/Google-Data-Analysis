"""Fix vitahaven and vitasphere main.js to support JSON article loading.
When article.content is missing (index-only entry), fetch from js/articles/{id}.json.
"""
import paramiko, sys, re
sys.stdout.reconfigure(encoding='utf-8')

pkey = paramiko.RSAKey.from_private_key_file(r"C:\Users\Administrator\Desktop\密钥\awssg0306.pem")
bt = paramiko.SSHClient()
bt.set_missing_host_key_policy(paramiko.AutoAddPolicy())
bt.connect("52.74.221.116", 22, "ubuntu", pkey=pkey, timeout=15)
sftp = bt.open_sftp()

def read_remote(path):
    with sftp.open(path, "r") as f:
        return f.read().decode("utf-8")

def write_remote(path, content):
    with sftp.open(path, "w") as f:
        f.write(content.encode("utf-8"))

# ═══ Fix 1: vitahaven.click ═══
print("=== Fixing vitahaven.click main.js ===")
vh_path = "/www/wwwroot/vitahaven.click/js/main.js"
vh_js = read_remote(vh_path)

# Replace displayArticleDetail function
old_vh_func = '''// Display article detail
function displayArticleDetail() {
    const params = new URLSearchParams(window.location.search);
    const titleSlug = params.get('title');
    
    // Support both old id format and new title format for backward compatibility
    let article;
    if (titleSlug) {
        // Find article by matching slug
        article = articles.find(a => generateSlug(a.title) === titleSlug);
    } else {
        // Fallback to id for backward compatibility
        const articleId = parseInt(params.get('id'));
        if (articleId) {
            article = articles.find(a => a.id === articleId);
        }
    }
    
    if (!article) {
        window.location.href = 'index.html';
        return;
    }
    
    // Update page title
    document.title = `${article.title} - VitaHaven`;
    
    // Create article detail HTML
    const articleHTML = `
        <article class="article-detail">
            <div class="container">
                <div class="article-header">
                    <span class="article-category">${article.categoryName}</span>
                    <h1 class="article-title">${article.title}</h1>
                    <div class="article-meta">
                        <span class="article-date">
                            <i class="far fa-calendar"></i>
                            ${formatDate(article.date)}
                        </span>
                    </div>
                </div>
                
                <img src="${article.image}" alt="${article.title}" class="article-featured-image">
                
                <div class="article-body">
                    ${article.content}
                </div>
                
                ${article.products && article.products.length > 0 ? `
                    <div class="product-section">
                        <h2>Recommended Products</h2>
                        <div class="product-grid">
                            ${article.products.map(product => `
                                <div class="product-card">
                                    <img src="${product.image}" alt="${product.name}" class="product-image">
                                    <div class="product-info">
                                        <h3 class="product-name">${product.name}</h3>
                                        <p class="product-description">${product.description}</p>
                                    </div>
                                </div>
                            `).join('')}
                        </div>
                    </div>
                ` : ''}
            </div>
        </article>
    `;
    
    // Insert before footer
    const footer = document.querySelector('.footer');
    if (footer) {
        footer.insertAdjacentHTML('beforebegin', articleHTML);
    }
}'''

new_vh_func = '''// Display article detail (supports both inline content and JSON loading)
function displayArticleDetail() {
    const params = new URLSearchParams(window.location.search);
    const titleSlug = params.get('title');
    
    let article;
    if (titleSlug) {
        article = articles.find(a => generateSlug(a.title) === titleSlug);
        if (!article) article = articles.find(a => a.slug === titleSlug);
    } else {
        const articleId = parseInt(params.get('id'));
        if (articleId) {
            article = articles.find(a => a.id === articleId);
        }
    }
    
    if (!article) {
        window.location.href = 'index.html';
        return;
    }
    
    if (!article.content && article.id) {
        fetch(`js/articles/${article.id}.json`)
            .then(r => r.ok ? r.json() : null)
            .then(data => {
                if (data) {
                    article.content = data.content || '';
                    article.products = data.products || article.products;
                    if (data.author) article.author = data.author;
                }
                _renderArticleDetail(article);
            })
            .catch(() => _renderArticleDetail(article));
    } else {
        _renderArticleDetail(article);
    }
}

function _renderArticleDetail(article) {
    document.title = `${article.title} - VitaHaven`;
    
    const articleHTML = `
        <article class="article-detail">
            <div class="container">
                <div class="article-header">
                    <span class="article-category">${article.categoryName}</span>
                    <h1 class="article-title">${article.title}</h1>
                    <div class="article-meta">
                        <span class="article-date">
                            <i class="far fa-calendar"></i>
                            ${formatDate(article.date)}
                        </span>
                    </div>
                </div>
                
                <img src="${article.image}" alt="${article.title}" class="article-featured-image">
                
                <div class="article-body">
                    ${article.content || '<p>Content loading failed.</p>'}
                </div>
                
                ${article.products && article.products.length > 0 ? `
                    <div class="product-section">
                        <h2>Recommended Products</h2>
                        <div class="product-grid">
                            ${article.products.map(product => `
                                <div class="product-card">
                                    <img src="${product.image}" alt="${product.name}" class="product-image">
                                    <div class="product-info">
                                        <h3 class="product-name">${product.name}</h3>
                                        <p class="product-description">${product.description}</p>
                                    </div>
                                </div>
                            `).join('')}
                        </div>
                    </div>
                ` : ''}
            </div>
        </article>
    `;
    
    const footer = document.querySelector('.footer');
    if (footer) {
        footer.insertAdjacentHTML('beforebegin', articleHTML);
    }
}'''

if old_vh_func in vh_js:
    vh_js_new = vh_js.replace(old_vh_func, new_vh_func)
    write_remote(vh_path, vh_js_new)
    print("✓ vitahaven main.js updated successfully")
else:
    print("✗ Could not find displayArticleDetail in vitahaven main.js")
    print("  Attempting fuzzy match...")
    # Try line by line
    if 'function displayArticleDetail()' in vh_js and '${article.content}' in vh_js:
        # Find the function boundaries
        start = vh_js.index('function displayArticleDetail()')
        # Find comment before it
        comment_start = vh_js.rfind('//', 0, start)
        if comment_start > start - 50:
            start = comment_start
        
        # Find the next top-level function
        func_pattern = re.compile(r'\n(?:function |// Display |// Search |// Category )', re.MULTILINE)
        remaining = vh_js[start + 10:]  # skip past the opening
        matches = list(func_pattern.finditer(remaining))
        
        # Find the closing } by counting braces
        depth = 0
        end = start
        found_first_brace = False
        for i in range(start, len(vh_js)):
            if vh_js[i] == '{':
                depth += 1
                found_first_brace = True
            elif vh_js[i] == '}':
                depth -= 1
                if found_first_brace and depth == 0:
                    end = i + 1
                    break
        
        if end > start:
            old_section = vh_js[start:end]
            print(f"  Found function: {len(old_section)} chars (line approx)")
            vh_js_new = vh_js[:start] + new_vh_func + vh_js[end:]
            write_remote(vh_path, vh_js_new)
            print("  ✓ vitahaven main.js updated via fuzzy match")
        else:
            print("  ✗ Could not find function boundaries")
    else:
        print("  ✗ Function not found at all")

# ═══ Fix 2: vitasphere.top ═══
print("\n=== Fixing vitasphere.top main.js ===")
vs_path = "/www/wwwroot/vitasphere.top/js/main.js"
vs_js = read_remote(vs_path)

# Find displayArticle function
# vitasphere uses displayArticle(slug) and article.content directly
# Need to add JSON loading when content is missing

old_vs_marker = "function displayArticle(slug) {"
if old_vs_marker in vs_js:
    # Find the function
    start = vs_js.index(old_vs_marker)
    
    # Find the end of the function by counting braces
    depth = 0
    end = start
    found_first_brace = False
    for i in range(start, len(vs_js)):
        if vs_js[i] == '{':
            depth += 1
            found_first_brace = True
        elif vs_js[i] == '}':
            depth -= 1
            if found_first_brace and depth == 0:
                end = i + 1
                break
    
    old_func = vs_js[start:end]
    print(f"Found displayArticle function: {len(old_func)} chars")
    
    new_vs_func = '''function displayArticle(slug) {
    // URLSearchParams.get() already decodes the parameter, so slug is already decoded
    const decodedSlug = slug;
    
    const article = articles.find(a => {
        const articleSlug = (a.title || '').toLowerCase().trim()
            .replace(/[^\\w\\s-]/g, '').replace(/[\\s_-]+/g, '-').replace(/^-+|-+$/g, '');
        return articleSlug === decodedSlug || a.slug === decodedSlug;
    });
    
    if (!article) {
        const mainContent = document.getElementById('articleContent') || document.querySelector('main') || document.body;
        mainContent.innerHTML = '<div class="container" style="padding: 3rem; text-align: center;"><h1>Article not found</h1><p>The article you are looking for could not be found.</p><a href="index.html" style="color: var(--primary-color); text-decoration: underline;">Return to home</a></div>';
        return;
    }
    
    if (!article.content && article.id) {
        fetch(`js/articles/${article.id}.json`)
            .then(r => r.ok ? r.json() : null)
            .then(data => {
                if (data) {
                    article.content = data.content || '';
                    article.products = data.products || article.products;
                    if (data.author) article.author = data.author;
                }
                _renderArticlePage(article);
            })
            .catch(() => _renderArticlePage(article));
    } else {
        _renderArticlePage(article);
    }
}

function _renderArticlePage(article) {
    const categoryName = categoryNames[article.category] || article.categoryName || article.category;
    
    document.title = `${article.title} - VitaSphere`;
    
    const mainContent = document.getElementById('articleContent') || document.querySelector('main') || document.body;
    mainContent.innerHTML = `
        <article class="article-page">
            <div class="container">
                <div class="article-header">
                    <div class="article-category">${categoryName}</div>
                    <h1 class="article-title">${article.title}</h1>
                    <div class="article-meta">
                        <span>${formatDate(article.date)}</span>
                        <span>By ${article.author || 'Editorial Team'}</span>
                    </div>
                </div>
                <div class="article-body">
                    <img src="${article.image}" alt="${article.title}">
                    ${article.content || '<p>Content not available.</p>'}
                </div>
            </div>
        </article>
    `;
}'''
    
    vs_js_new = vs_js[:start] + new_vs_func + vs_js[end:]
    write_remote(vs_path, vs_js_new)
    print("✓ vitasphere main.js updated successfully")
else:
    print("✗ Could not find displayArticle in vitasphere main.js")

sftp.close()
bt.close()
print("\nDone!")
