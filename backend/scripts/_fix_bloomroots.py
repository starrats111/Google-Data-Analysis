"""Fix bloomroots: restore articlesData in script.js + merge with articlesIndex for new articles"""
import paramiko, sys, json
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

br = "/www/wwwroot/bloomroots.top"

# Step 1: We need to restore the original script.js with articlesData
# The original is in git. Let's check if there's a backup or use the Luchu folder
print("=== Step 1: Find original script.js ===")

# Check local Luchu folder
import os
local_candidates = [
    r"D:\Google Analysis\Luchu\BloomRoots\script.js",
    r"D:\Google Analysis\Luchu\bloomroots\script.js",
]
local_script = None
for p in local_candidates:
    if os.path.exists(p):
        local_script = p
        print(f"Found local: {p}")
        break

if not local_script:
    # Search
    print("Searching locally...")
    for root_dir, dirs, files in os.walk(r"D:\Google Analysis\Luchu"):
        for f in files:
            if f == "script.js":
                fp = os.path.join(root_dir, f)
                with open(fp, 'r', encoding='utf-8', errors='replace') as fh:
                    content = fh.read(200)
                if 'articlesData' in content:
                    local_script = fp
                    print(f"Found: {fp}")
                    break
        if local_script:
            break

if local_script:
    print(f"Using: {local_script}")
    with open(local_script, 'r', encoding='utf-8') as f:
        original_script = f.read()
    print(f"Original script.js: {len(original_script)} chars")
    
    # Change const articlesData to var articlesData to avoid conflict
    original_script = original_script.replace("const articlesData", "var articlesData")
    
    # Upload restored script.js
    with sftp.open(f"{br}/script.js", "w") as f:
        f.write(original_script.encode("utf-8"))
    print("Restored script.js with var articlesData")
else:
    print("Cannot find original script.js locally, using git restore on server")
    # Try git restore
    out = r(f"cd {br} && git checkout -- script.js 2>&1 || echo 'NO GIT'")
    print(f"Git restore: {out}")
    
    if "NO GIT" in out:
        # Alternative: reconstruct from js/articles/ JSON files
        print("Reconstructing articlesData from js/articles/ JSON files...")
        articles = []
        for i in range(1, 7):
            try:
                with sftp.open(f"{br}/js/articles/{i}.json", "r") as f:
                    data = json.loads(f.read().decode("utf-8"))
                articles.append(data)
            except:
                pass
        
        if articles:
            # Read current script.js
            with sftp.open(f"{br}/script.js", "r") as f:
                current_script = f.read().decode("utf-8")
            
            # Build articlesData from JSON files
            # The original format uses content as array of paragraphs
            js_articles = []
            for a in articles:
                entry = {
                    "id": a.get("id", 0),
                    "title": a.get("title", ""),
                    "category": a.get("category", ""),
                    "categoryName": a.get("categoryName", ""),
                    "excerpt": a.get("excerpt", ""),
                    "image": a.get("image", ""),
                    "heroImage": a.get("heroImage", a.get("image", "")),
                    "date": a.get("date", ""),
                    "author": a.get("author", "Editorial Team"),
                }
                # Convert HTML content to array of paragraphs
                content = a.get("content", "")
                if isinstance(content, str):
                    import re
                    paragraphs = re.findall(r'<p>(.*?)</p>', content, re.DOTALL)
                    if paragraphs:
                        entry["content"] = paragraphs
                    else:
                        entry["content"] = [content[:500]]
                elif isinstance(content, list):
                    entry["content"] = content
                js_articles.append(entry)
            
            articles_json = json.dumps(js_articles, ensure_ascii=False, indent=2)
            
            # Insert at the beginning of script.js
            new_script = f"var articlesData = {articles_json};\n\n{current_script.replace('// articlesData loaded from js/articles-index.js', '')}"
            
            with sftp.open(f"{br}/script.js", "w") as f:
                f.write(new_script.encode("utf-8"))
            print(f"Reconstructed articlesData with {len(js_articles)} articles")

# Step 2: Fix articles-index.js to properly merge with articlesData
print("\n=== Step 2: Fix articles-index.js ===")
with sftp.open(f"{br}/js/articles-index.js", "r") as f:
    idx_content = f.read().decode("utf-8")

# Replace the tail comment with actual merge code
# articlesIndex has new articles from our publishing system
# articlesData has the original template articles
# We need script.js to see ALL articles
new_tail = """
// 兼容旧代码: 将新发布的文章合并到 articlesData
if (typeof articlesData !== 'undefined' && Array.isArray(articlesData)) {
  // 将 articlesIndex 中的新文章追加到 articlesData（避免重复）
  articlesIndex.forEach(function(newArt) {
    var exists = articlesData.some(function(a) { return a.id === newArt.id || a.title === newArt.title; });
    if (!exists) {
      // 新文章可能没有 content 数组，从 js/articles/{id}.json 异步加载
      articlesData.unshift(newArt);
    }
  });
} else {
  // articlesData 不存在时，用 articlesIndex 作为 fallback
  var articlesData = articlesIndex;
}
"""

# Remove old tail comments
lines = idx_content.split("\n")
clean_lines = []
for line in lines:
    if line.strip().startswith("// 兼容") or line.strip().startswith("// articlesData") or line.strip().startswith("var articlesData"):
        continue
    if line.strip().startswith("var articles =") or line.strip().startswith("const articles ="):
        continue
    clean_lines.append(line)

new_idx = "\n".join(clean_lines).rstrip() + "\n" + new_tail

with sftp.open(f"{br}/js/articles-index.js", "w") as f:
    f.write(new_idx.encode("utf-8"))
print("Updated articles-index.js with merge logic")

# Step 3: Also need to fix article detail loading for new articles
# New articles from our system have HTML content, not array content
# We need to patch loadArticleContent to handle both formats
print("\n=== Step 3: Check if loadArticleContent handles HTML content ===")
with sftp.open(f"{br}/script.js", "r") as f:
    script_content = f.read().decode("utf-8")

# Check if it already handles string content
if "Array.isArray(article.content)" in script_content:
    print("Already has Array.isArray check - good")
elif "article.content && Array.isArray" in script_content:
    print("Has array check but may need HTML fallback")
    # The existing code has a fallback for non-array content that shows lorem ipsum
    # We need to change it to show the actual HTML content
    old_fallback = """    } else {
        // Fallback for articles without content array
        articleBodyHTML = `
            <p>${article.excerpt}</p>
            <p>Lorem ipsum dolor sit amet, consectetur adipiscing elit. Sed do eiusmod tempor incididunt ut labore et dolore magna aliqua. Ut enim ad minim veniam, quis nostrud exercitation ullamco laboris nisi ut aliquip ex ea commodo consequat.</p>
            <p>Duis aute irure dolor in reprehenderit in voluptate velit esse cillum dolore eu fugiat nulla pariatur. Excepteur sint occaecat cupidatat non proident, sunt in culpa qui officia deserunt mollit anim id est laborum.</p>
            <p>Sed ut perspiciatis unde omnis iste natus error sit voluptatem accusantium doloremque laudantium, totam rem aperiam, eaque ipsa quae ab illo inventore veritatis et quasi architecto beatae vitae dicta sunt explicabo.</p>
        `;
    }"""
    
    new_fallback = """    } else if (typeof article.content === 'string') {
        // HTML content from publishing system
        articleBodyHTML = article.content;
    } else {
        // Fallback: try loading from js/articles/{id}.json
        articleBodyHTML = '<p>' + (article.excerpt || '') + '</p>';
        if (article.id) {
            fetch('js/articles/' + article.id + '.json')
                .then(function(r) { return r.json(); })
                .then(function(data) {
                    if (data && data.content) {
                        var el = document.querySelector('.article-body');
                        if (el) el.innerHTML = typeof data.content === 'string' ? data.content : data.content.map(function(p) { return '<p>' + p + '</p>'; }).join('');
                    }
                })
                .catch(function() {});
        }
    }"""
    
    if old_fallback in script_content:
        script_content = script_content.replace(old_fallback, new_fallback)
        with sftp.open(f"{br}/script.js", "w") as f:
            f.write(script_content.encode("utf-8"))
        print("Patched loadArticleContent to handle HTML content + JSON fallback")
    else:
        print("Could not find exact fallback pattern, trying flexible match...")
        # Try a more flexible approach
        import re
        pattern = r'(\s*\} else \{[^}]*?Fallback for articles without content array.*?Lorem ipsum.*?\};)'
        match = re.search(pattern, script_content, re.DOTALL)
        if match:
            script_content = script_content[:match.start()] + new_fallback + script_content[match.end():]
            with sftp.open(f"{br}/script.js", "w") as f:
                f.write(script_content.encode("utf-8"))
            print("Patched with flexible match")
        else:
            print("WARNING: Could not patch loadArticleContent")

# Step 4: Verify
print("\n=== Verify ===")
out = r(f"head -5 {br}/script.js")
print(f"script.js head:\n{out}")
out = r(f"grep -c 'articlesData' {br}/script.js")
print(f"articlesData references in script.js: {out}")
out = r(f"cat {br}/js/articles-index.js")
print(f"\narticles-index.js:\n{out}")

sftp.close()
bt.close()
print("\nDone!")
