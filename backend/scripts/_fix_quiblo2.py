"""Fix quiblo: patch loadArticle to fetch content from JSON when not available inline"""
import paramiko, sys
sys.stdout.reconfigure(encoding='utf-8')
pkey = paramiko.RSAKey.from_private_key_file(r"C:\Users\Administrator\Desktop\密钥\awssg0306.pem")
bt = paramiko.SSHClient()
bt.set_missing_host_key_policy(paramiko.AutoAddPolicy())
bt.connect("52.74.221.116", 22, "ubuntu", pkey=pkey, timeout=15)
sftp = bt.open_sftp()

qb = "/www/wwwroot/quiblo.top"

with sftp.open(f"{qb}/script.js", "r") as f:
    script = f.read().decode("utf-8")

# Replace the loadArticle function to handle missing content
old_func = """function loadArticle() {
    const urlParams = new URLSearchParams(window.location.search);
    const titleSlug = urlParams.get('title');
    
    // Find article by matching slug
    const article = blogPosts.find(post => titleToSlug(post.title) === titleSlug);
    
    if (!article) {
        document.body.innerHTML = `
            <div style="text-align: center; padding: 100px 20px;">
                <h1>Article Not Found</h1>
                <p>The article you're looking for doesn't exist.</p>
                <a href="index.html" class="back-link">Back to Home</a>
            </div>
        `;
        return;
    }
    
    // Update page title
    document.title = `${article.title} - Quiblo`;
    
    // Create article HTML
    const articleHTML = `
        <div class="container">
            <a href="index.html" class="back-link">
                <i class="fas fa-arrow-left"></i> Back to Home
            </a>
            
            <article class="article-header sticky-header">
                <div class="article-header-image">
                    <img src="${article.image}" alt="${article.title}">
                </div>
                <div class="article-header-content">
                    <span class="blog-card-category">${getCategoryName(article.category)}</span>
                    <h1 class="article-title">${article.title}</h1>
                    <div class="article-meta">
                        <span><i class="far fa-calendar"></i> ${formatDate(article.date)}</span>
                        <span><i class="fas fa-tag"></i> ${getCategoryName(article.category)}</span>
                    </div>
                </div>
            </article>
            
            <div class="article-content">
                ${article.content}
            </div>
            
            ${generateRecommendedProducts(article.id)}
        </div>
    `;
    
    // Replace main content
    const mainContent = document.querySelector('.main-content') || document.querySelector('main') || document.body;
    if (mainContent) {
        mainContent.innerHTML = articleHTML;
    }
}"""

new_func = """function loadArticle() {
    const urlParams = new URLSearchParams(window.location.search);
    const titleSlug = urlParams.get('title');
    
    // Find article by matching slug
    const article = blogPosts.find(post => titleToSlug(post.title) === titleSlug);
    
    if (!article) {
        document.body.innerHTML = `
            <div style="text-align: center; padding: 100px 20px;">
                <h1>Article Not Found</h1>
                <p>The article you're looking for doesn't exist.</p>
                <a href="index.html" class="back-link">Back to Home</a>
            </div>
        `;
        return;
    }
    
    // Update page title
    document.title = `${article.title} - Quiblo`;
    
    function renderArticle(contentHTML) {
        const articleHTML = `
            <div class="container">
                <a href="index.html" class="back-link">
                    <i class="fas fa-arrow-left"></i> Back to Home
                </a>
                
                <article class="article-header sticky-header">
                    <div class="article-header-image">
                        <img src="${article.image}" alt="${article.title}">
                    </div>
                    <div class="article-header-content">
                        <span class="blog-card-category">${getCategoryName(article.category)}</span>
                        <h1 class="article-title">${article.title}</h1>
                        <div class="article-meta">
                            <span><i class="far fa-calendar"></i> ${formatDate(article.date)}</span>
                            <span><i class="fas fa-tag"></i> ${getCategoryName(article.category)}</span>
                        </div>
                    </div>
                </article>
                
                <div class="article-content">
                    ${contentHTML}
                </div>
                
                ${generateRecommendedProducts(article.id)}
            </div>
        `;
        const mainContent = document.querySelector('.main-content') || document.querySelector('main') || document.body;
        if (mainContent) {
            mainContent.innerHTML = articleHTML;
        }
    }
    
    // If article has inline content, render directly
    if (article.content) {
        renderArticle(article.content);
    } else if (article.id) {
        // Load content from js/articles/{id}.json
        fetch('js/articles/' + article.id + '.json')
            .then(function(resp) { return resp.ok ? resp.json() : null; })
            .then(function(data) {
                if (data && data.content) {
                    renderArticle(typeof data.content === 'string' ? data.content : data.content.map(function(p) { return '<p>' + p + '</p>'; }).join(''));
                } else {
                    renderArticle('<p>' + (article.excerpt || 'Content not available.') + '</p>');
                }
            })
            .catch(function() {
                renderArticle('<p>' + (article.excerpt || 'Content not available.') + '</p>');
            });
    } else {
        renderArticle('<p>' + (article.excerpt || 'Content not available.') + '</p>');
    }
}"""

if old_func in script:
    script = script.replace(old_func, new_func)
    with sftp.open(f"{qb}/script.js", "w") as f:
        f.write(script.encode("utf-8"))
    print("SUCCESS: Patched quiblo loadArticle with JSON fallback")
else:
    print("Exact match not found, trying to locate...")
    idx = script.find("function loadArticle()")
    if idx >= 0:
        # Find the end of the function
        next_func = script.find("\nfunction ", idx + 20)
        if next_func > 0:
            old_block = script[idx:next_func]
            script = script[:idx] + new_func + "\n" + script[next_func:]
            with sftp.open(f"{qb}/script.js", "w") as f:
                f.write(script.encode("utf-8"))
            print(f"Replaced loadArticle ({len(old_block)} -> {len(new_func)} chars)")
    else:
        print("ERROR: Cannot find loadArticle function")

# Also need to add data.js to article.html if it's not there
# Actually, since articles-index.js now provides blogPosts via fallback, we don't need data.js
# The issue is that index.html also doesn't load data.js, so the homepage won't show template articles
# Let's check if index.html works

print("\n=== Check if quiblo index.html loads data.js ===")
def r(cmd, t=15):
    stdin, stdout, stderr = bt.exec_command(cmd, timeout=t)
    stdout.channel.recv_exit_status()
    return stdout.read().decode('utf-8', errors='replace').strip()

# Check all HTML files for data.js
for html in ["index.html", "article.html", "articles.html"]:
    out = r(f"grep 'data.js' {qb}/{html} 2>/dev/null")
    print(f"  {html}: {'has data.js' if out else 'NO data.js'}")

# Since no HTML loads data.js, blogPosts comes entirely from articles-index.js
# But articles-index.js only has 6 index entries without content
# The template articles (1-6) have content in js/articles/{id}.json
# So our loadArticle fix should handle this correctly

print("\n=== Verify quiblo fix ===")
out = r(f"grep -n 'function loadArticle\\|fetch.*json\\|renderArticle' {qb}/script.js | head -10")
print(out)

sftp.close()
bt.close()
print("\nDone!")
