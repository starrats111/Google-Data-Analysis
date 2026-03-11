import paramiko, sys, json
sys.stdout.reconfigure(encoding='utf-8')

ssh = paramiko.SSHClient()
ssh.set_missing_host_key_policy(paramiko.AutoAddPolicy())

# Connect to Baota server (where sites are hosted)
ssh.connect("52.74.221.116", username="ubuntu", password="A123456", timeout=10)

def run(cmd, timeout=15):
    stdin, stdout, stderr = ssh.exec_command(cmd, timeout=timeout)
    return stdout.read().decode('utf-8', errors='replace'), stderr.read().decode('utf-8', errors='replace')

SITE_ROOT = "/www/wwwroot"

# 1. Check zontri.top site structure
print("=== zontri.top site structure ===", flush=True)
out, _ = run(f"ls -la {SITE_ROOT}/zontri.top/ 2>/dev/null | head -20")
print(out, flush=True)

# 2. Check for article HTML files
print("=== Article HTML files ===", flush=True)
out, _ = run(f"find {SITE_ROOT}/zontri.top/ -name '*holy-grail*' -o -name '*fira*' 2>/dev/null")
print(out if out.strip() else "(no matching files found)", flush=True)

# 3. Check the JS data file (posts.js / main.js)
print("=== JS data files ===", flush=True)
out, _ = run(f"find {SITE_ROOT}/zontri.top/ -name '*.js' -path '*/assets/*' 2>/dev/null | head -10")
print(out, flush=True)
out, _ = run(f"find {SITE_ROOT}/zontri.top/ -name 'main.js' -o -name 'posts.js' -o -name 'articles.js' 2>/dev/null")
print(out, flush=True)

# 4. Check article.html to understand how it loads articles
print("=== article.html structure ===", flush=True)
out, _ = run(f"head -50 {SITE_ROOT}/zontri.top/article.html 2>/dev/null")
print(out[:2000], flush=True)

# 5. Check for posts directory
print("=== posts/articles directory ===", flush=True)
out, _ = run(f"ls -la {SITE_ROOT}/zontri.top/posts/ 2>/dev/null")
print(out if out.strip() else "(no posts/ dir)", flush=True)
out, _ = run(f"ls -la {SITE_ROOT}/zontri.top/articles/ 2>/dev/null")
print(out if out.strip() else "(no articles/ dir)", flush=True)

# 6. Check the main JS file content for posts array
print("=== Check posts data in JS ===", flush=True)
for js_path in ["assets/js/main.js", "assets/js/posts.js", "js/main.js", "js/posts.js", "main.js"]:
    full = f"{SITE_ROOT}/zontri.top/{js_path}"
    out, _ = run(f"head -5 {full} 2>/dev/null")
    if out.strip():
        print(f"Found: {js_path}", flush=True)
        out2, _ = run(f"grep -c 'holy-grail\\|slug\\|title' {full} 2>/dev/null")
        print(f"  Matches: {out2.strip()}", flush=True)
        out3, _ = run(f"wc -c {full} 2>/dev/null")
        print(f"  Size: {out3.strip()}", flush=True)

ssh.close()

# Also check the backend database for this article's publish details
print("\n=== Check backend DB ===", flush=True)
ssh2 = paramiko.SSHClient()
ssh2.set_missing_host_key_policy(paramiko.AutoAddPolicy())
ssh2.connect("47.239.193.33", username="admin", password="A123456", timeout=10)

stdin, stdout, stderr = ssh2.exec_command(
    'cd /home/admin/Google-Data-Analysis/backend && source venv/bin/activate && python3 -c "'
    'from app.database import SessionLocal; '
    'from app.models.article import Article; '
    'db = SessionLocal(); '
    'arts = db.query(Article).filter(Article.title.like(\"%Holy Grail%\")).all(); '
    '[print(f\"id={a.id} status={a.status} site={a.publish_site} slug={a.slug} url={a.publish_url}\") for a in arts]; '
    'db.close()" 2>&1',
    timeout=15
)
print(stdout.read().decode('utf-8', errors='replace'), flush=True)

# Check publish logs
stdin, stdout, stderr = ssh2.exec_command(
    "grep -i 'zontri\\|holy.grail\\|publish' /home/admin/backend.log 2>/dev/null | tail -30",
    timeout=15
)
print("=== Backend publish logs ===", flush=True)
print(stdout.read().decode('utf-8', errors='replace')[-3000:], flush=True)

ssh2.close()
