"""
Comprehensive fix & deploy:
1. Check AI service on backend server (47.239.193.33)
2. Create PubSite records on backend server
3. Fix vitahaven articles-index.js on Baota server (52.74.221.116)
4. Deploy code to backend server
"""
import paramiko
import sys
import json
import time
sys.stdout.reconfigure(encoding='utf-8')

BACKEND_HOST = "47.239.193.33"
BACKEND_USER = "admin"
BACKEND_PASS = "A123456"
BACKEND_PATH = "/home/admin/Google-Data-Analysis/backend"

BT_HOST = "52.74.221.116"
BT_USER = "ubuntu"
BT_KEY = r"C:\Users\Administrator\Desktop\密钥\awssg0306.pem"

# === Connect to Backend Server ===
print("=== Connecting to Backend Server ===")
be = paramiko.SSHClient()
be.set_missing_host_key_policy(paramiko.AutoAddPolicy())
be.connect(BACKEND_HOST, 22, BACKEND_USER, password=BACKEND_PASS, timeout=15)

def be_run(cmd, t=30):
    stdin, stdout, stderr = be.exec_command(cmd, timeout=t)
    stdout.channel.recv_exit_status()
    out = stdout.read().decode('utf-8', errors='replace').strip()
    err = stderr.read().decode('utf-8', errors='replace').strip()
    return out, err

# Step 1: Check AI config
print("\n=== Step 1: Check AI config ===")
out, _ = be_run(f"grep -i 'gemini' {BACKEND_PATH}/.env | head -10")
print(out)

# Step 2: Test AI API
print("\n=== Step 2: Test AI API ===")
test_py = '''import sys, json, os
sys.path.insert(0, ".")
os.chdir("''' + BACKEND_PATH + '''")
from dotenv import load_dotenv
load_dotenv()
import httpx

api_key = os.getenv("gemini_api_key", "")
base_url = os.getenv("gemini_base_url", "https://api.gemai.cc")

if not api_key:
    print("ERROR: No API key!")
    sys.exit(1)

url = f"{base_url.rstrip('/')}/v1/chat/completions"
headers = {"Authorization": f"Bearer {api_key}", "Content-Type": "application/json"}

models = ["claude-sonnet-4-6", "deepseek-chat"]
for model in models:
    try:
        payload = {
            "model": model,
            "messages": [
                {"role": "system", "content": "You are a JSON API. Output ONLY valid JSON."},
                {"role": "user", "content": "Return: {\\"brand\\":\\"Nike\\",\\"products\\":[\\"shoes\\"],\\"selling_points\\":[\\"quality\\"]}"}
            ],
            "max_tokens": 200, "temperature": 0.3
        }
        resp = httpx.post(url, json=payload, headers=headers, timeout=30)
        if resp.status_code == 200:
            content = resp.json()["choices"][0]["message"]["content"]
            print(f"  {model}: OK -> {content[:150]}")
        else:
            print(f"  {model}: HTTP {resp.status_code} -> {resp.text[:200]}")
    except Exception as e:
        print(f"  {model}: ERROR -> {e}")
'''
be_sftp = be.open_sftp()
with be_sftp.open("/tmp/_test_ai.py", "w") as f:
    f.write(test_py.encode("utf-8"))
out, err = be_run(f"cd {BACKEND_PATH} && source venv/bin/activate && python3 /tmp/_test_ai.py", 60)
print(out)
if err:
    print(f"STDERR: {err}")

# Step 3: Check deployed article_gen_service.py models
print("\n=== Step 3: Check deployed AI service models ===")
out, _ = be_run(f"head -20 {BACKEND_PATH}/app/services/article_gen_service.py")
print(out)

# Step 4: Check recent logs
print("\n=== Step 4: Recent crawl/AI errors ===")
out, _ = be_run(f"tail -200 /home/admin/backend.log 2>/dev/null | grep -i 'crawl\\|分析\\|ArticleGen\\|失败\\|error' | tail -20")
print(out or "(no matching log lines)")

# Step 5: Create PubSite records
print("\n=== Step 5: Create PubSite records ===")
SITES = [
    ("VitaHaven", "vitahaven.click", "/www/wwwroot/vitahaven.click", "articles_index", "js/articles-index.js", "articlesIndex", "article.html?title={slug}"),
    ("Zontri", "zontri.top", "/www/wwwroot/zontri.top", "articles_index", "js/articles-index.js", "articlesIndex", "article.html?title={slug}"),
    ("VitaSphere", "vitasphere.top", "/www/wwwroot/vitasphere.top", "articles_index", "js/articles-index.js", "articlesIndex", "article.html?slug={slug}"),
    ("EverydayHaven", "everydayhaven.top", "/www/wwwroot/everydayhaven.top", "articles_index", "js/articles-index.js", "articlesIndex", "article.html?name={slug}"),
    ("BloomRoots", "bloomroots.top", "/www/wwwroot/bloomroots.top", "articles_index", "js/articles-index.js", "articlesIndex", "article.html?title={slug}"),
    ("Quiblo", "quiblo.top", "/www/wwwroot/quiblo.top", "articles_index", "js/articles-index.js", "articlesIndex", "article.html?title={slug}"),
    ("AlluraHub", "allurahub.top", "/www/wwwroot/allurahub.top", "articles_index", "js/articles-index.js", "articlesIndex", "article.html?title={slug}"),
    ("Mevora", "mevora.top", "/www/wwwroot/mevora.top", "articles_inline", "js/main.js", "articles", "article.html?title={slug}"),
    ("Kivanta", "kivanta.top", "/www/wwwroot/kivanta.top", "articles_inline", "js/main.js", "articles", "article.html?title={slug}"),
]

seed_py = f'''import sys, os
sys.path.insert(0, ".")
os.chdir("{BACKEND_PATH}")
from dotenv import load_dotenv
load_dotenv()
from app.database import SessionLocal
from app.models.site import PubSite
from app.models.user import User

db = SessionLocal()
admin = db.query(User).first()
if not admin:
    print("ERROR: No users")
    sys.exit(1)
admin_id = admin.id
print(f"Admin: id={{admin_id}}, username={{admin.username}}")

sites = {repr(SITES)}

created = 0
updated = 0
for name, domain, path, stype, djs, var, pattern in sites:
    existing = db.query(PubSite).filter(PubSite.domain == domain).first()
    if existing:
        existing.site_type = stype
        existing.data_js_path = djs
        existing.article_var_name = var
        existing.article_html_pattern = pattern
        existing.site_path = path
        updated += 1
        print(f"  Updated: {{domain}} (id={{existing.id}})")
    else:
        site = PubSite(
            group_id=1,
            site_name=name,
            site_path=path,
            domain=domain,
            site_type=stype,
            data_js_path=djs,
            article_var_name=var,
            article_html_pattern=pattern,
            created_by=admin_id,
        )
        db.add(site)
        created += 1
        print(f"  Created: {{domain}}")

db.commit()
all_sites = db.query(PubSite).all()
print(f"Result: created={{created}}, updated={{updated}}, total={{len(all_sites)}}")
for s in all_sites:
    print(f"  id={{s.id}} | {{s.domain}} | type={{s.site_type}} | pattern={{s.article_html_pattern}}")
db.close()
'''
with be_sftp.open("/tmp/_seed_pubsites.py", "w") as f:
    f.write(seed_py.encode("utf-8"))
out, err = be_run(f"cd {BACKEND_PATH} && source venv/bin/activate && python3 /tmp/_seed_pubsites.py", 20)
print(out)
if err:
    print(f"STDERR: {err}")

be_sftp.close()
be.close()

# === Connect to Baota Server for site fixes ===
print("\n=== Step 6: Fix vitahaven on Baota Server ===")
pkey = paramiko.RSAKey.from_private_key_file(BT_KEY)
bt = paramiko.SSHClient()
bt.set_missing_host_key_policy(paramiko.AutoAddPolicy())
bt.connect(BT_HOST, 22, BT_USER, pkey=pkey, timeout=15)

def bt_run(cmd, t=15):
    stdin, stdout, stderr = bt.exec_command(cmd, timeout=t)
    stdout.channel.recv_exit_status()
    return stdout.read().decode('utf-8', errors='replace').strip()

bt_sftp = bt.open_sftp()
vh = "/www/wwwroot/vitahaven.click"

# Fix Python booleans in articles-index.js
bt_run(f"sed -i 's/hasProducts: False/hasProducts: false/g; s/hasProducts: True/hasProducts: true/g' {vh}/js/articles-index.js")

# Read current articles-index.js
idx_content = bt_run(f"cat {vh}/js/articles-index.js")
print(f"Current vitahaven articles-index.js:\n{idx_content}")

# Check Vivid Seats article location
vs_slug = "the-smart-way-to-buy-event-tickets-in-2026-why-vivid-seats-rewards-program-changes-everything"
vs_in_articles = bt_run(f"test -f {vh}/articles/{vs_slug}.json && echo EXISTS || echo MISSING")
print(f"\nVivid Seats in articles/: {vs_in_articles}")

if vs_in_articles == "EXISTS":
    vs_content = bt_run(f"cat {vh}/articles/{vs_slug}.json")
    try:
        vs_data = json.loads(vs_content)
        new_id = 6
        vs_data["id"] = new_id
        new_json = json.dumps(vs_data, ensure_ascii=False, indent=2)
        
        with bt_sftp.open(f"{vh}/js/articles/{new_id}.json", "w") as f:
            f.write(new_json.encode("utf-8"))
        print(f"Written js/articles/{new_id}.json ({len(new_json)} chars)")
        
        # Update articles-index.js id
        idx_new = idx_content.replace("\n    id: 1,", f"\n    id: {new_id},", 1)
        if idx_new != idx_content:
            with bt_sftp.open(f"{vh}/js/articles-index.js", "w") as f:
                f.write(idx_new.encode("utf-8"))
            print(f"Updated articlesIndex id: 1 -> {new_id}")
    except Exception as e:
        print(f"Error: {e}")

# Verify
print("\n=== Verification ===")
print(bt_run(f"cat {vh}/js/articles-index.js"))
print(f"\njs/articles/ listing:")
print(bt_run(f"ls -la {vh}/js/articles/"))

bt_sftp.close()
bt.close()
print("\nAll done!")
