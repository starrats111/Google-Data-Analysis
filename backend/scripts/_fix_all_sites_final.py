"""
ONE-SHOT FIX: Fix ALL sites on Baota server.

Site categories:
A) B1-SPA with main.js (vitahaven, zontri, vitasphere, everydayhaven):
   - articles-index.js has articlesIndex (index data)
   - js/main.js has article loading logic
   - js/data.js has const articles (template data with content)
   - Problem: const articles declared in both data.js and articles-index.js -> conflict
   - Fix: articles-index.js use var, add merge code, ensure main.js has JSON fetch fallback

B) B1-SPA with script.js (bloomroots, quiblo):
   - Already fixed in previous step

C) B2-inline (mevora):
   - js/main.js has articlesData inline (with content)
   - No articles-index.js, no js/articles/ dir
   - Fix: create js/articles/ dir, create articles-index.js, patch article.js for JSON fallback

D) Static HTML (kivanta, aura-bloom, novanest, keymint):
   - Each article is a separate .html file (post-{slug}.html or {slug}.html)
   - Publishing = generate static HTML file
   - Fix: update PubSite config, remote_publisher handles this type

E) No article system (aurislane, everydaynes, allurahub):
   - Skip or minimal setup
"""
import paramiko, sys, re
sys.stdout.reconfigure(encoding='utf-8')

pkey = paramiko.RSAKey.from_private_key_file(r"C:\Users\Administrator\Desktop\密钥\awssg0306.pem")
bt = paramiko.SSHClient()
bt.set_missing_host_key_policy(paramiko.AutoAddPolicy())
bt.connect("52.74.221.116", 22, "ubuntu", pkey=pkey, timeout=15)
sftp = bt.open_sftp()

def r(cmd, t=15):
    stdin, stdout, stderr = bt.exec_command(cmd, timeout=t)
    stdout.channel.recv_exit_status()
    return stdout.read().decode('utf-8', errors='replace').strip()

def read_remote(path):
    try:
        with sftp.open(path, "r") as f:
            return f.read().decode("utf-8")
    except:
        return None

def write_remote(path, content):
    with sftp.open(path, "w") as f:
        f.write(content.encode("utf-8"))

errors = []
fixed = []

# ============================================================
# Category A: B1-SPA with main.js
# vitahaven, zontri, vitasphere, everydayhaven
# ============================================================
print("=" * 60)
print("Category A: B1-SPA with main.js")
print("=" * 60)

CATEGORY_A = {
    "vitahaven.click": "title",
    "zontri.top": "title",
    "vitasphere.top": "slug",
    "everydayhaven.top": "name",
}

for domain, url_param in CATEGORY_A.items():
    root = f"/www/wwwroot/{domain}"
    print(f"\n--- {domain} (param={url_param}) ---")
    
    # Fix 1: articles-index.js - const -> var, add merge code
    idx_path = f"{root}/js/articles-index.js"
    idx = read_remote(idx_path)
    if not idx:
        print(f"  ERROR: articles-index.js not found!")
        errors.append(f"{domain}: articles-index.js missing")
        continue
    
    changed = False
    
    # const articlesIndex -> var articlesIndex
    if "const articlesIndex" in idx:
        idx = idx.replace("const articlesIndex", "var articlesIndex")
        changed = True
        print(f"  Fixed: const articlesIndex -> var")
    
    # const articles = articlesIndex -> var articles = articlesIndex
    if "const articles = " in idx:
        idx = idx.replace("const articles = ", "var articles = ")
        changed = True
        print(f"  Fixed: const articles -> var")
    
    # Remove any existing merge code to avoid duplication
    # Then add clean merge code
    merge_marker = "// 兼容旧代码"
    if merge_marker in idx:
        # Remove everything from merge_marker to end
        marker_pos = idx.index(merge_marker)
        idx = idx[:marker_pos].rstrip() + "\n"
        changed = True
    
    # Add proper merge code
    merge_code = f"""
// 兼容旧代码: 合并 articlesIndex 到 articles (data.js)
if (typeof articles !== 'undefined' && Array.isArray(articles)) {{
  articlesIndex.forEach(function(newArt) {{
    var exists = articles.some(function(a) {{ return a.id === newArt.id || a.slug === newArt.slug; }});
    if (!exists) {{
      articles.unshift(newArt);
    }}
  }});
}} else {{
  var articles = articlesIndex;
}}
"""
    idx = idx.rstrip() + "\n" + merge_code
    changed = True
    
    if changed:
        write_remote(idx_path, idx)
        print(f"  Updated articles-index.js with merge code")
        fixed.append(f"{domain}: articles-index.js")
    
    # Fix 2: data.js - const articles -> var articles
    data_path = f"{root}/js/data.js"
    data = read_remote(data_path)
    if data and "const articles" in data:
        data = data.replace("const articles = [", "var articles = [", 1)
        write_remote(data_path, data)
        print(f"  Fixed: data.js const articles -> var")
        fixed.append(f"{domain}: data.js")
    elif data:
        print(f"  data.js: already uses var or no articles declaration")
    else:
        print(f"  data.js: not found (OK for some sites)")
    
    # Fix 3: main.js - ensure article loading has JSON fetch fallback
    main_path = f"{root}/js/main.js"
    main = read_remote(main_path)
    if not main:
        print(f"  ERROR: main.js not found!")
        errors.append(f"{domain}: main.js missing")
        continue
    
    # Check if main.js already has fetch for articles JSON
    has_json_fetch = "fetch(" in main and "articles" in main and ".json" in main
    if has_json_fetch:
        print(f"  main.js: already has JSON fetch - OK")
    else:
        print(f"  main.js: needs JSON fetch fallback")
        # Find the article content rendering section
        # These sites typically have a function that renders article detail
        # Look for patterns like: articleContent.innerHTML or document.getElementById('articleContent')
        
        # Strategy: find where article.content is used and add a fallback
        # Common pattern: something like `${article.content}` or article.content
        
        # Check for template literal usage
        if "${article.content}" in main or "article.content" in main:
            # Find the line that uses article.content
            lines = main.split('\n')
            new_lines = []
            patched = False
            
            for i, line in enumerate(lines):
                new_lines.append(line)
                
                # After the line that sets innerHTML with article content,
                # add a fallback that loads from JSON if content is empty
                if not patched and 'innerHTML' in line and ('articleContent' in line or 'article-content' in line or 'mainContent' in line):
                    # Check if next few lines have the closing of the template
                    # We need to add the JSON fetch after the innerHTML assignment
                    pass
            
            # Alternative approach: find the function that loads article detail
            # and wrap the content rendering with a check
            
            # Look for the pattern where article is found and content is rendered
            # Add a post-render hook that loads JSON if content is missing
            
            # Inject a small script at the end of main.js
            json_fallback = f"""

// JSON fallback: 如果文章内容为空，从 js/articles/{{id}}.json 加载
(function() {{
  var params = new URLSearchParams(window.location.search);
  var paramVal = params.get('{url_param}');
  if (!paramVal || !document.querySelector('.article-content, .article-body, #articleContent')) return;
  
  var contentEl = document.querySelector('.article-content, .article-body, #articleContent');
  if (!contentEl) return;
  
  // 检查内容是否为空或只有 undefined
  var text = contentEl.textContent || '';
  if (text.trim() && text.trim() !== 'undefined' && text.trim().length > 50) return;
  
  // 尝试从 articlesIndex 找到文章 ID
  if (typeof articlesIndex === 'undefined') return;
  var art = articlesIndex.find(function(a) {{
    return a.slug === paramVal || a.title === paramVal;
  }});
  if (!art || !art.id) return;
  
  fetch('js/articles/' + art.id + '.json')
    .then(function(resp) {{ return resp.ok ? resp.json() : null; }})
    .then(function(data) {{
      if (data && data.content) {{
        contentEl.innerHTML = typeof data.content === 'string'
          ? data.content
          : data.content.map(function(p) {{ return '<p>' + p + '</p>'; }}).join('');
      }}
    }})
    .catch(function() {{}});
}})();
"""
            main = main.rstrip() + "\n" + json_fallback
            write_remote(main_path, main)
            print(f"  Added JSON fetch fallback to main.js")
            fixed.append(f"{domain}: main.js JSON fallback")
        else:
            print(f"  main.js: no article.content pattern found, skipping")
    
    # Fix 4: Ensure js/articles/ directory exists
    out = r(f"test -d {root}/js/articles && echo Y || echo N")
    if out == "N":
        r(f"mkdir -p {root}/js/articles")
        print(f"  Created js/articles/ directory")
    
    # Fix 5: Fix Python booleans in articles-index.js
    idx2 = read_remote(idx_path)
    if idx2:
        for old, new in [("hasProducts: False", "hasProducts: false"),
                         ("hasProducts: True", "hasProducts: true"),
                         ("featured: False", "featured: false"),
                         ("featured: True", "featured: true")]:
            if old in idx2:
                idx2 = idx2.replace(old, new)
        write_remote(idx_path, idx2)

print(f"\n  Category A done: {len([f for f in fixed if any(d in f for d in CATEGORY_A)])} fixes")

# ============================================================
# Category B: B1-SPA with script.js (bloomroots, quiblo)
# Already fixed - just verify
# ============================================================
print("\n" + "=" * 60)
print("Category B: B1-SPA with script.js (verify)")
print("=" * 60)

for domain in ["bloomroots.top", "quiblo.top"]:
    root = f"/www/wwwroot/{domain}"
    print(f"\n--- {domain} ---")
    
    idx = read_remote(f"{root}/js/articles-index.js")
    if idx:
        has_merge = "forEach" in idx or "merge" in idx.lower()
        has_var = "var articlesIndex" in idx
        print(f"  articles-index.js: merge={'YES' if has_merge else 'NO'}, var={'YES' if has_var else 'NO'}")
        if not has_var and "const articlesIndex" in idx:
            idx = idx.replace("const articlesIndex", "var articlesIndex")
            write_remote(f"{root}/js/articles-index.js", idx)
            print(f"  Fixed: const -> var")
            fixed.append(f"{domain}: articles-index.js const->var")
    
    # Fix Python booleans
    idx2 = read_remote(f"{root}/js/articles-index.js")
    if idx2:
        for old, new in [("hasProducts: False", "hasProducts: false"),
                         ("hasProducts: True", "hasProducts: true")]:
            if old in idx2:
                idx2 = idx2.replace(old, new)
                write_remote(f"{root}/js/articles-index.js", idx2)
                print(f"  Fixed Python booleans")
                break
        else:
            print(f"  Booleans OK")

# ============================================================
# Category C: B2-inline (mevora)
# ============================================================
print("\n" + "=" * 60)
print("Category C: B2-inline (mevora)")
print("=" * 60)

domain = "mevora.top"
root = f"/www/wwwroot/{domain}"
print(f"\n--- {domain} ---")

# Create js/articles/ directory
r(f"mkdir -p {root}/js/articles")
print(f"  Created js/articles/ directory")

# Create articles-index.js (empty, will be populated on first publish)
idx_path = f"{root}/js/articles-index.js"
idx = read_remote(idx_path)
if not idx:
    idx_content = """// 文章索引 - 由发布系统管理
var articlesIndex = [];

// 合并到 articlesData (main.js)
if (typeof articlesData !== 'undefined' && Array.isArray(articlesData)) {
  articlesIndex.forEach(function(newArt) {
    var exists = articlesData.some(function(a) { return a.id === newArt.id || a.title === newArt.title; });
    if (!exists) {
      articlesData.unshift(newArt);
    }
  });
} else {
  var articlesData = articlesIndex;
}
"""
    write_remote(idx_path, idx_content)
    print(f"  Created articles-index.js")
    fixed.append(f"{domain}: articles-index.js created")

# Add articles-index.js to article.html before article.js
art_html = read_remote(f"{root}/article.html")
if art_html and "articles-index.js" not in art_html:
    # Insert before the first script tag
    art_html = art_html.replace(
        '<script src="js/article.js">',
        '<script src="js/articles-index.js"></script>\n    <script src="js/article.js">'
    )
    write_remote(f"{root}/article.html", art_html)
    print(f"  Added articles-index.js to article.html")
    fixed.append(f"{domain}: article.html updated")

# Also add to index.html and articles.html
for html_name in ["index.html", "articles.html"]:
    html = read_remote(f"{root}/{html_name}")
    if html and "articles-index.js" not in html:
        html = html.replace(
            '<script src="js/main.js">',
            '<script src="js/articles-index.js"></script>\n    <script src="js/main.js">'
        )
        write_remote(f"{root}/{html_name}", html)
        print(f"  Added articles-index.js to {html_name}")

# Fix main.js: const articlesData -> var articlesData
main = read_remote(f"{root}/js/main.js")
if main and "const articlesData" in main:
    main = main.replace("const articlesData", "var articlesData")
    write_remote(f"{root}/js/main.js", main)
    print(f"  Fixed: main.js const articlesData -> var")
    fixed.append(f"{domain}: main.js")

# Patch article.js for JSON fallback
art_js = read_remote(f"{root}/js/article.js")
if art_js:
    if "fetch(" not in art_js or ".json" not in art_js:
        # Add JSON fallback at the end
        fallback = """

// JSON fallback: 新发布文章从 js/articles/{id}.json 加载内容
(function() {
  var params = new URLSearchParams(window.location.search);
  var titleSlug = params.get('title');
  if (!titleSlug) return;
  
  setTimeout(function() {
    var contentEl = document.querySelector('.article-content, .article-body, #articleContent');
    if (!contentEl) return;
    var text = contentEl.textContent || '';
    if (text.trim() && text.trim() !== 'undefined' && text.trim().length > 50) return;
    
    if (typeof articlesIndex === 'undefined' || !articlesIndex.length) return;
    var art = articlesIndex.find(function(a) { return a.slug === titleSlug; });
    if (!art || !art.id) return;
    
    fetch('js/articles/' + art.id + '.json')
      .then(function(resp) { return resp.ok ? resp.json() : null; })
      .then(function(data) {
        if (data && data.content) {
          contentEl.innerHTML = typeof data.content === 'string'
            ? data.content
            : data.content.map(function(p) { return '<p>' + p + '</p>'; }).join('');
        }
      })
      .catch(function() {});
  }, 500);
})();
"""
        art_js = art_js.rstrip() + "\n" + fallback
        write_remote(f"{root}/js/article.js", art_js)
        print(f"  Added JSON fallback to article.js")
        fixed.append(f"{domain}: article.js JSON fallback")
    else:
        print(f"  article.js: already has JSON fetch")

# ============================================================
# Category D: Static HTML sites
# kivanta, aura-bloom, novanest, keymint
# These generate individual post-{slug}.html files
# No SPA fix needed, just ensure PubSite config is correct
# ============================================================
print("\n" + "=" * 60)
print("Category D: Static HTML sites")
print("=" * 60)

STATIC_SITES = {
    "kivanta.top": ("articles_inline", "js/main.js", "articles", "{slug}.html"),
    "aura-bloom.top": ("posts_assets_js", "assets/js/main.js", "posts", "post-{slug}.html"),
    "novanest.one": ("posts_assets_js", "assets/js/main.js", "posts", "post-{slug}.html"),
    "keymint.co": ("posts_scripts", "assets/js/posts.js", "posts", "post-{slug}.html"),
}

for domain, (stype, djs, var, pattern) in STATIC_SITES.items():
    root = f"/www/wwwroot/{domain}"
    print(f"\n--- {domain} (type={stype}, pattern={pattern}) ---")
    
    # Ensure the data JS file uses var instead of const for the array
    js_path = f"{root}/{djs}"
    js = read_remote(js_path)
    if js:
        for old_kw in ["const " + var + " ", "const " + var + "="]:
            if old_kw in js:
                js = js.replace(old_kw, "var " + var + " " if " " in old_kw else "var " + var + "=")
                write_remote(js_path, js)
                print(f"  Fixed: {djs} const {var} -> var")
                fixed.append(f"{domain}: {djs}")
                break
        else:
            print(f"  {djs}: OK (no const conflict)")
    else:
        print(f"  {djs}: not found")

# ============================================================
# Category E: No article system
# ============================================================
print("\n" + "=" * 60)
print("Category E: No article system (skip)")
print("=" * 60)
for domain in ["aurislane.top", "everydaynes.top"]:
    print(f"  {domain}: no article system, skipping")

# ============================================================
# Fix allurahub.top - has articles-index.js but empty
# ============================================================
print("\n" + "=" * 60)
print("Fix allurahub.top")
print("=" * 60)
domain = "allurahub.top"
root = f"/www/wwwroot/{domain}"
idx = read_remote(f"{root}/js/articles-index.js")
if idx:
    if "const articlesIndex" in idx:
        idx = idx.replace("const articlesIndex", "var articlesIndex")
    if "const articles" in idx:
        idx = idx.replace("const articles", "var articles")
    write_remote(f"{root}/js/articles-index.js", idx)
    print(f"  Fixed const -> var")
    fixed.append(f"{domain}: articles-index.js")

# Fix main.js
main = read_remote(f"{root}/js/main.js")
if main:
    if "const articles" in main:
        main = main.replace("const articles = [", "var articles = [", 1)
        write_remote(f"{root}/js/main.js", main)
        print(f"  Fixed main.js const articles -> var")
    # Check data.js
    data = read_remote(f"{root}/js/data.js")
    if data and "const articles" in data:
        data = data.replace("const articles = [", "var articles = [", 1)
        write_remote(f"{root}/js/data.js", data)
        print(f"  Fixed data.js const articles -> var")

sftp.close()
bt.close()

# ============================================================
# Summary
# ============================================================
print("\n" + "=" * 60)
print(f"SUMMARY: {len(fixed)} fixes applied")
print("=" * 60)
for f in fixed:
    print(f"  ✓ {f}")
if errors:
    print(f"\n{len(errors)} ERRORS:")
    for e in errors:
        print(f"  ✗ {e}")
else:
    print("\nNo errors!")
