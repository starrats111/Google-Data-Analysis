"""Fix remaining 2 issues:
1. mevora.top: categoryMap conflict between main.js and article.js
2. allurahub.top: add merge code to articles-index.js
"""
import paramiko, sys
sys.stdout.reconfigure(encoding='utf-8')
pkey = paramiko.RSAKey.from_private_key_file(r"C:\Users\Administrator\Desktop\密钥\awssg0306.pem")
bt = paramiko.SSHClient()
bt.set_missing_host_key_policy(paramiko.AutoAddPolicy())
bt.connect("52.74.221.116", 22, "ubuntu", pkey=pkey, timeout=15)
sftp = bt.open_sftp()

def read_remote(path):
    try:
        with sftp.open(path, "r") as f:
            return f.read().decode("utf-8")
    except:
        return None

def write_remote(path, content):
    with sftp.open(path, "w") as f:
        f.write(content.encode("utf-8"))

# Fix 1: mevora.top - categoryMap in article.js conflicts with main.js
print("=== Fix mevora.top categoryMap conflict ===")
art_js = read_remote("/www/wwwroot/mevora.top/js/article.js")
if art_js:
    # Check if article.html loads main.js before article.js
    # If so, categoryMap from main.js is already available
    # Change const categoryMap in article.js to use the one from main.js
    if "const categoryMap" in art_js:
        # Replace first occurrence: const categoryMap = { ... } with a check
        import re
        # Find the full categoryMap declaration
        pattern = r'const categoryMap\s*=\s*\{'
        match = re.search(pattern, art_js)
        if match:
            start = match.start()
            # Find matching }
            brace_start = art_js.index('{', match.start())
            depth = 0
            i = brace_start
            while i < len(art_js):
                if art_js[i] == '{':
                    depth += 1
                elif art_js[i] == '}':
                    depth -= 1
                    if depth == 0:
                        break
                i += 1
            end = i + 1
            if end < len(art_js) and art_js[end] == ';':
                end += 1
            
            # Replace with: use existing or define
            old_decl = art_js[start:end]
            new_decl = "var categoryMap = (typeof categoryMap !== 'undefined') ? categoryMap : " + art_js[brace_start:i+1] + ";"
            art_js = art_js[:start] + new_decl + art_js[end:]
            write_remote("/www/wwwroot/mevora.top/js/article.js", art_js)
            print(f"  Fixed: categoryMap in article.js now checks for existing")
    
    # Also fix slug and article conflicts
    # These are likely in different function scopes, so they're fine
    # But let's check if article.js has top-level const that conflicts
    for var in ["slug", "article"]:
        # Check if it's top-level (not inside a function)
        lines = art_js.split('\n')
        for idx, line in enumerate(lines):
            stripped = line.strip()
            if stripped.startswith(f"const {var} ") or stripped.startswith(f"const {var}="):
                # Check indentation - if no indent, it's top-level
                if not line.startswith(' ') and not line.startswith('\t'):
                    print(f"  WARNING: top-level const {var} in article.js line {idx+1}")
else:
    print("  article.js not found")

# Fix 2: allurahub.top - add merge code
print("\n=== Fix allurahub.top merge code ===")
idx = read_remote("/www/wwwroot/allurahub.top/js/articles-index.js")
if idx:
    if "forEach" not in idx and "unshift" not in idx:
        # Check what variable the site uses
        main = read_remote("/www/wwwroot/allurahub.top/js/main.js")
        data = read_remote("/www/wwwroot/allurahub.top/js/data.js")
        
        # Determine the main articles variable
        main_var = "articles"  # default
        if main and "articlesData" in main:
            main_var = "articlesData"
        elif data and "articles" in data:
            main_var = "articles"
        
        merge_code = f"""
// 兼容旧代码: 合并 articlesIndex 到 {main_var}
if (typeof {main_var} !== 'undefined' && Array.isArray({main_var})) {{
  articlesIndex.forEach(function(newArt) {{
    var exists = {main_var}.some(function(a) {{ return a.id === newArt.id || a.slug === newArt.slug; }});
    if (!exists) {{
      {main_var}.unshift(newArt);
    }}
  }});
}} else {{
  var {main_var} = articlesIndex;
}}
"""
        idx = idx.rstrip() + "\n" + merge_code
        write_remote("/www/wwwroot/allurahub.top/js/articles-index.js", idx)
        print(f"  Added merge code (var={main_var})")
    else:
        print("  Already has merge code")
else:
    print("  articles-index.js not found")

# Fix 3: Also fix data.js const in allurahub
data = read_remote("/www/wwwroot/allurahub.top/js/data.js")
if data and "const articles" in data:
    data = data.replace("const articles", "var articles")
    write_remote("/www/wwwroot/allurahub.top/js/data.js", data)
    print("  Fixed: data.js const articles -> var")

sftp.close()
bt.close()
print("\nDone!")
