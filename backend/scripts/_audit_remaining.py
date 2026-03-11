"""Quick audit of remaining sites"""
import paramiko, sys
sys.stdout.reconfigure(encoding='utf-8')
pkey = paramiko.RSAKey.from_private_key_file(r"C:\Users\Administrator\Desktop\密钥\awssg0306.pem")
bt = paramiko.SSHClient()
bt.set_missing_host_key_policy(paramiko.AutoAddPolicy())
bt.connect("52.74.221.116", 22, "ubuntu", pkey=pkey, timeout=15)
def r(cmd, t=15):
    stdin, stdout, stderr = bt.exec_command(cmd, timeout=t)
    stdout.channel.recv_exit_status()
    return stdout.read().decode('utf-8', errors='replace').strip()

for domain in ["mevora.top", "kivanta.top", "aura-bloom.top", "aurislane.top", "everydaynes.top", "novanest.one", "keymint.co"]:
    root = f"/www/wwwroot/{domain}"
    print(f"\n=== {domain} ===")
    
    # Files
    files = r(f"ls {root}/*.html {root}/js/*.js {root}/*.js {root}/assets/js/*.js {root}/assets/*.js {root}/scripts/*.js 2>/dev/null | sed 's|{root}/||g'")
    print(f"  Files: {files.replace(chr(10), ', ')}")
    
    # article.html scripts
    scripts = r(f"grep -o 'src=\"[^\"]*\"' {root}/article.html 2>/dev/null")
    print(f"  article.html scripts: {scripts.replace(chr(10), ', ') if scripts else 'N/A'}")
    
    # index.html scripts
    scripts = r(f"grep -o 'src=\"[^\"]*\\.js[^\"]*\"' {root}/index.html 2>/dev/null | head -5")
    print(f"  index.html scripts: {scripts.replace(chr(10), ', ') if scripts else 'N/A'}")
    
    # Variable declarations
    for jsf in ["js/main.js", "js/articles-index.js", "script.js", "data.js", "assets/js/main.js", "assets/main.js", "scripts/main.js"]:
        out = r(f"grep -n '^\\(const\\|var\\|let\\|window\\.\\)' {root}/{jsf} 2>/dev/null | head -5")
        if out:
            print(f"  {jsf}: {out.replace(chr(10), ' | ')}")
    
    # URL params
    for jsf in ["js/main.js", "script.js", "assets/js/main.js", "assets/main.js", "scripts/main.js"]:
        out = r(f"grep -o \"get('[a-z]*')\" {root}/{jsf} 2>/dev/null | sort -u | head -5")
        if out:
            print(f"  URL params ({jsf}): {out.replace(chr(10), ', ')}")
            break
    
    # js/articles/ count
    out = r(f"ls {root}/js/articles/*.json 2>/dev/null | wc -l")
    print(f"  js/articles/ JSON: {out}")
    
    # Has article.html?
    has_art = r(f"test -f {root}/article.html && echo Y || echo N")
    if has_art == "N":
        # Check for post-*.html pattern
        posts = r(f"ls {root}/post-*.html 2>/dev/null | wc -l")
        print(f"  post-*.html files: {posts}")

bt.close()
print("\nDone!")
