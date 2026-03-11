"""Fix quiblo: same pattern as bloomroots - data.js has blogPosts, articles-index.js conflicts"""
import paramiko, sys
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

qb = "/www/wwwroot/quiblo.top"

# Step 1: Fix articles-index.js - use var, merge with blogPosts
print("=== Fix quiblo articles-index.js ===")
with sftp.open(f"{qb}/js/articles-index.js", "r") as f:
    idx = f.read().decode("utf-8")

# Replace const with var
idx = idx.replace("const articlesIndex", "var articlesIndex")

# Remove the conflicting blogPosts alias at the end
lines = idx.split("\n")
clean_lines = []
for line in lines:
    if line.strip().startswith("const blogPosts") or line.strip().startswith("var blogPosts"):
        continue
    if line.strip().startswith("// 兼容旧代码"):
        continue
    clean_lines.append(line)

# Add merge logic
merge_code = """
// 兼容旧代码: 将新发布的文章合并到 blogPosts
if (typeof blogPosts !== 'undefined' && Array.isArray(blogPosts)) {
  articlesIndex.forEach(function(newArt) {
    var exists = blogPosts.some(function(a) { return a.id === newArt.id || a.title === newArt.title; });
    if (!exists) {
      blogPosts.unshift(newArt);
    }
  });
} else {
  var blogPosts = articlesIndex;
}
"""

new_idx = "\n".join(clean_lines).rstrip() + "\n" + merge_code
with sftp.open(f"{qb}/js/articles-index.js", "w") as f:
    f.write(new_idx.encode("utf-8"))
print("Fixed articles-index.js: var + merge logic")

# Step 2: Fix data.js - change const to var
print("\n=== Fix quiblo data.js ===")
with sftp.open(f"{qb}/data.js", "r") as f:
    data_js = f.read().decode("utf-8")

if "const blogPosts" in data_js:
    data_js = data_js.replace("const blogPosts", "var blogPosts")
    with sftp.open(f"{qb}/data.js", "w") as f:
        f.write(data_js.encode("utf-8"))
    print("Changed const blogPosts -> var blogPosts in data.js")
else:
    print("data.js already uses var or let")

# Step 3: Fix script.js - patch loadArticle to handle HTML content + JSON fallback
print("\n=== Fix quiblo script.js ===")
with sftp.open(f"{qb}/script.js", "r") as f:
    script = f.read().decode("utf-8")

# Check if loadArticle has a fallback for non-template articles
# quiblo's loadArticle uses blogPosts.find() and then renders content
# The content in data.js uses template literals with HTML
# New articles from our system will have HTML string content too
# But they might not have all the fields (products, etc.)

# Check what happens when article is not found
if "window.location.href = 'index.html'" in script or "redirect" in script.lower():
    print("Has redirect on article not found")

# Check if it handles string content
if "article.content" in script:
    # Find the loadArticle function
    idx = script.find("function loadArticle()")
    if idx >= 0:
        # Get the function body
        func_end = script.find("\nfunction ", idx + 10)
        if func_end < 0:
            func_end = len(script)
        func_body = script[idx:func_end]
        print(f"loadArticle function ({len(func_body)} chars)")
        
        # Check if it already handles the case
        if "fetch(" in func_body or "json" in func_body.lower():
            print("Already has fetch/json handling")
        else:
            print("Needs JSON fallback for new articles")
            # The quiblo loadArticle likely renders content directly as HTML
            # Since our published articles also have HTML content, it should work
            # The issue is only if the article is in articlesIndex but not in blogPosts
            # Our merge code above should handle that
    else:
        print("loadArticle function not found")

# Also fix filteredPosts initialization
if "let filteredPosts = [...blogPosts]" in script:
    # This runs at parse time, before articles-index.js merge happens
    # Need to defer it
    print("filteredPosts initialized at parse time - may need fix")
    # Actually, article.html loads articles-index.js BEFORE script.js
    # So the merge happens before script.js runs
    # But data.js is loaded via <script src="data.js"> which is before articles-index.js
    # Let's check the load order
    
print("\n=== article.html script load order ===")
print(r(f"grep 'script' {qb}/article.html"))

print("\n=== index.html script load order ===")
print(r(f"grep 'script' {qb}/index.html | head -10"))

# Verify
print("\n=== Verify ===")
print(r(f"head -3 {qb}/js/articles-index.js"))
print("...")
print(r(f"tail -15 {qb}/js/articles-index.js"))
print(f"\ndata.js first line: {r(f'head -2 {qb}/data.js')}")

sftp.close()
bt.close()
print("\nDone!")
