"""
Comprehensive audit of ALL sites on Baota server.
For each site, check:
1. HTML script load order
2. Variable declarations (const/var/let conflicts)
3. articles-index.js content and merge code
4. article.html article loading logic (URL param, content rendering)
5. js/articles/ directory existence
6. Whether loadArticle/loadArticleContent handles JSON fallback
"""
import paramiko, sys, json
sys.stdout.reconfigure(encoding='utf-8')

pkey = paramiko.RSAKey.from_private_key_file(r"C:\Users\Administrator\Desktop\密钥\awssg0306.pem")
bt = paramiko.SSHClient()
bt.set_missing_host_key_policy(paramiko.AutoAddPolicy())
bt.connect("52.74.221.116", 22, "ubuntu", pkey=pkey, timeout=15)

def r(cmd, t=15):
    stdin, stdout, stderr = bt.exec_command(cmd, timeout=t)
    stdout.channel.recv_exit_status()
    return stdout.read().decode('utf-8', errors='replace').strip()

ALL_DOMAINS = [
    "vitahaven.click", "zontri.top", "vitasphere.top", "everydayhaven.top",
    "bloomroots.top", "quiblo.top", "allurahub.top", "mevora.top", "kivanta.top",
    "aura-bloom.top", "aurislane.top", "everydaynes.top", "novanest.one", "keymint.co",
]

for domain in ALL_DOMAINS:
    root = f"/www/wwwroot/{domain}"
    print(f"\n{'='*70}")
    print(f"  {domain}")
    print(f"{'='*70}")
    
    # 1. Check which files exist
    exists = {}
    for f in ["index.html", "article.html", "articles.html", "category.html",
              "js/articles-index.js", "js/main.js", "js/data.js", "script.js",
              "data.js", "assets/js/main.js", "assets/main.js", "scripts/main.js"]:
        out = r(f"test -f {root}/{f} && echo Y || echo N")
        if out == "Y":
            exists[f] = True
    print(f"  Files: {', '.join(exists.keys())}")
    
    # 2. Check js/articles/ dir
    out = r(f"ls {root}/js/articles/ 2>/dev/null | wc -l")
    json_count = int(out) if out.isdigit() else 0
    print(f"  js/articles/ JSON files: {json_count}")
    
    # 3. Script tags in article.html
    if "article.html" in exists:
        out = r(f"grep -o 'src=\"[^\"]*\"' {root}/article.html 2>/dev/null")
        print(f"  article.html scripts: {out.replace(chr(10), ', ')}")
    
    # 4. Script tags in index.html
    if "index.html" in exists:
        out = r(f"grep -o 'src=\"[^\"]*\"' {root}/index.html 2>/dev/null | head -10")
        print(f"  index.html scripts: {out.replace(chr(10), ', ')}")
    
    # 5. Variable declarations in each JS file
    for jsf in ["js/articles-index.js", "js/main.js", "js/data.js", "script.js", "data.js",
                "assets/js/main.js", "assets/main.js", "scripts/main.js"]:
        if jsf not in exists:
            continue
        out = r(f"grep -n '^\\(const\\|var\\|let\\|window\\.\\)' {root}/{jsf} 2>/dev/null | head -10")
        if out:
            print(f"  {jsf} vars: {out.replace(chr(10), ' | ')}")
    
    # 6. URL param in article loading
    if "article.html" in exists:
        # Check inline script in article.html
        out = r(f"grep -o \"get('[a-z]*')\" {root}/article.html 2>/dev/null | head -5")
        if not out:
            # Check in JS files
            for jsf in ["script.js", "js/main.js", "assets/js/main.js", "assets/main.js", "scripts/main.js"]:
                if jsf in exists:
                    out = r(f"grep -o \"get('[a-z]*')\" {root}/{jsf} 2>/dev/null | head -5")
                    if out:
                        print(f"  URL params ({jsf}): {out.replace(chr(10), ', ')}")
                        break
        else:
            print(f"  URL params (article.html): {out.replace(chr(10), ', ')}")
    
    # 7. Check for variable conflicts
    # Collect all top-level variable names across all loaded JS files
    if "article.html" in exists:
        scripts_in_html = r(f"grep -o 'src=\"[^\"]*\\.js[^\"]*\"' {root}/article.html 2>/dev/null")
        script_files = [s.replace('src="', '').replace('"', '').split('?')[0] for s in scripts_in_html.split('\n') if s]
        
        all_vars = {}  # var_name -> [(file, keyword)]
        for sf in script_files:
            sf_path = f"{root}/{sf}"
            out = r(f"grep -oP '(?:const|var|let)\\s+\\w+' {sf_path} 2>/dev/null | head -20")
            if out:
                for line in out.split('\n'):
                    parts = line.strip().split()
                    if len(parts) == 2:
                        kw, vname = parts
                        if vname not in all_vars:
                            all_vars[vname] = []
                        all_vars[vname].append((sf, kw))
        
        # Find conflicts: same variable declared in multiple files
        conflicts = {k: v for k, v in all_vars.items() if len(v) > 1}
        if conflicts:
            print(f"  ⚠️ CONFLICTS:")
            for vname, sources in conflicts.items():
                print(f"    {vname}: {', '.join(f'{kw} in {f}' for f, kw in sources)}")
    
    # 8. Check if articles-index.js has merge code
    if "js/articles-index.js" in exists:
        out = r(f"grep -c 'merge\\|兼容\\|articlesData\\|blogPosts\\|forEach' {root}/js/articles-index.js 2>/dev/null")
        has_merge = int(out) > 0 if out.isdigit() else False
        out2 = r(f"head -3 {root}/js/articles-index.js && echo '...' && tail -3 {root}/js/articles-index.js")
        print(f"  articles-index.js merge code: {'YES' if has_merge else 'NO'}")
        # Check const vs var
        out3 = r(f"grep -o '^\\(const\\|var\\|let\\) articlesIndex' {root}/js/articles-index.js 2>/dev/null")
        print(f"  articlesIndex declaration: {out3 or 'not found'}")
    
    # 9. Check article content loading (does it handle missing content?)
    for jsf in ["script.js", "js/main.js", "assets/js/main.js", "assets/main.js", "scripts/main.js"]:
        if jsf not in exists:
            continue
        out = r(f"grep -c 'fetch.*json\\|loadArticle\\|article\\.content' {root}/{jsf} 2>/dev/null")
        if out and int(out) > 0:
            has_fetch = r(f"grep -c 'fetch.*articles.*json' {root}/{jsf} 2>/dev/null")
            print(f"  {jsf}: article loading refs={out}, has JSON fetch={'YES' if has_fetch and int(has_fetch) > 0 else 'NO'}")

bt.close()
print(f"\n{'='*70}")
print("AUDIT COMPLETE")
print(f"{'='*70}")
