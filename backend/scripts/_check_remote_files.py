import paramiko, sys
sys.stdout.reconfigure(encoding='utf-8')

ssh = paramiko.SSHClient()
ssh.set_missing_host_key_policy(paramiko.AutoAddPolicy())
ssh.connect("47.239.193.33", username="admin", password="A123456", timeout=10)

sftp = ssh.open_sftp()
with sftp.open("/tmp/check_remote.py", "w") as f:
    f.write('''
import sys, os, json, stat
sys.path.insert(0, "/home/admin/Google-Data-Analysis/backend")
os.chdir("/home/admin/Google-Data-Analysis/backend")

from app.services.remote_publisher import RemotePublisher

pub = RemotePublisher()
ssh_client = pub._connect()
sftp = ssh_client.open_sftp()

SITE_ROOT = "/www/wwwroot/zontri.top"

# 1. List site files
print("=== Site root ===")
try:
    items = sftp.listdir_attr(SITE_ROOT)
    for item in items:
        t = "d" if stat.S_ISDIR(item.st_mode) else "-"
        print(f"  {t} {item.filename} ({item.st_size})")
except Exception as e:
    print(f"Error: {e}")

# 2. Read articles-index.js
data_js = f"{SITE_ROOT}/js/articles-index.js"
print(f"\\n=== {data_js} ===")
try:
    with sftp.open(data_js, "r") as f:
        content = f.read().decode("utf-8", errors="replace")
    print(f"Size: {len(content)} bytes")
    print(f"First 500 chars:\\n{content[:500]}")
    
    import re
    slug_matches = re.findall(r'"slug"\\s*:\\s*"([^"]+)"', content)
    print(f"\\nSlugs in index ({len(slug_matches)}):")
    for s in slug_matches:
        print(f"  {s}")
    
    id_matches = re.findall(r'"id"\\s*:\\s*(\\d+)', content)
    print(f"\\nIDs: {id_matches}")
except Exception as e:
    print(f"Error: {e}")

# 3. Check js/articles/ directory
js_articles = f"{SITE_ROOT}/js/articles"
print(f"\\n=== {js_articles}/ ===")
try:
    items = sftp.listdir(js_articles)
    print(f"Files: {items}")
    for fname in items[:5]:
        try:
            with sftp.open(f"{js_articles}/{fname}", "r") as f:
                jdata = json.loads(f.read().decode())
            print(f"  {fname}: slug={jdata.get('slug','?')[:60]} title={jdata.get('title','?')[:50]}")
        except Exception as e:
            print(f"  {fname}: error={e}")
except Exception as e:
    print(f"Error: {e}")

# 4. Check article.html content
article_html = f"{SITE_ROOT}/article.html"
print(f"\\n=== article.html (slug lookup logic) ===")
try:
    with sftp.open(article_html, "r") as f:
        html = f.read().decode("utf-8", errors="replace")
    # Find the slug lookup logic
    import re
    title_search = re.findall(r'title|slug|URLSearchParams|query|param', html, re.IGNORECASE)
    print(f"Keyword matches: {len(title_search)}")
    
    # Find the relevant JS sections
    for pattern in ["URLSearchParams", "title", "slug", "articlesIndex", "articles-index"]:
        if pattern.lower() in html.lower():
            idx = html.lower().index(pattern.lower())
            ctx = html[max(0,idx-100):idx+200]
            print(f"\\nContext for '{pattern}':\\n  {ctx[:300]}")
except Exception as e:
    print(f"Error: {e}")

# 5. Check image directory
img_dir = f"{SITE_ROOT}/image"
print(f"\\n=== {img_dir}/ ===")
try:
    items = sftp.listdir(img_dir)
    post_dirs = [i for i in items if i.startswith("post-")]
    print(f"Post image dirs: {len(post_dirs)}")
    for d in post_dirs[:5]:
        print(f"  {d}")
except Exception as e:
    print(f"Error: {e}")

sftp.close()
ssh_client.close()
''')
sftp.close()

stdin, stdout, stderr = ssh.exec_command(
    f"cd /home/admin/Google-Data-Analysis/backend && source venv/bin/activate && python3 /tmp/check_remote.py 2>&1",
    timeout=30
)
print(stdout.read().decode('utf-8', errors='replace'), flush=True)

ssh.close()
