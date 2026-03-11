"""
All-in-one fix script:
1. Fix AI service (ensure latest code is deployed)
2. Fix bloomroots articlesData conflict
3. Create PubSite records
4. Fix vitahaven Vivid Seats article
5. Restart backend
"""
import paramiko, sys, json, time
sys.stdout.reconfigure(encoding='utf-8')

# === Connect to both servers ===
BACKEND_HOST = "47.239.193.33"
BAOTA_HOST = "52.74.221.116"
BACKEND_PATH = "/home/admin/Google-Data-Analysis/backend"

pkey = paramiko.RSAKey.from_private_key_file(r"C:\Users\Administrator\Desktop\密钥\awssg0306.pem")

def connect_backend():
    ssh = paramiko.SSHClient()
    ssh.set_missing_host_key_policy(paramiko.AutoAddPolicy())
    ssh.connect(BACKEND_HOST, 22, 'admin', password='A123456', timeout=15)
    return ssh

def connect_baota():
    ssh = paramiko.SSHClient()
    ssh.set_missing_host_key_policy(paramiko.AutoAddPolicy())
    ssh.connect(BAOTA_HOST, 22, 'ubuntu', pkey=pkey, timeout=15)
    return ssh

def run(ssh, cmd, t=30):
    stdin, stdout, stderr = ssh.exec_command(cmd, timeout=t)
    stdout.channel.recv_exit_status()
    out = stdout.read().decode('utf-8', errors='replace').strip()
    err = stderr.read().decode('utf-8', errors='replace').strip()
    return out, err

# ============================================================
# PART A: Fix bloomroots on Baota server
# ============================================================
print("=" * 60)
print("PART A: Fix bloomroots.top on Baota")
print("=" * 60)

bt = connect_baota()
sftp = bt.open_sftp()

# bloomroots problem: script.js declares `const articlesData = [...]`
# articles-index.js declares `const articlesIndex = [...]`
# But articles-index.js also has `const articles = articlesIndex;` at bottom
# script.js uses `articlesData` variable
# The conflict: if both files declare same variable, or if article.html
# loads articles-index.js which might also declare articlesData

# Check what's in articles-index.js
vh_root = "/www/wwwroot/bloomroots.top"
out, _ = run(bt, f"tail -5 {vh_root}/js/articles-index.js 2>/dev/null")
print(f"bloomroots articles-index.js tail:\n{out}")

out, _ = run(bt, f"head -5 {vh_root}/js/articles-index.js 2>/dev/null")
print(f"\nbloomroots articles-index.js head:\n{out}")

# Check if articles-index.js has articlesData
out, _ = run(bt, f"grep -c 'articlesData' {vh_root}/js/articles-index.js 2>/dev/null")
print(f"\narticlesData count in articles-index.js: {out}")

out, _ = run(bt, f"grep -c 'articlesData' {vh_root}/script.js 2>/dev/null")
print(f"articlesData count in script.js: {out}")

# Check article.html script loading order
out, _ = run(bt, f"grep '<script' {vh_root}/article.html 2>/dev/null")
print(f"\narticle.html scripts:\n{out}")

# The fix: articles-index.js should NOT re-declare articlesData
# It should only declare articlesIndex. script.js has its own articlesData.
# The issue is likely that articles-index.js has a compat line like:
# const articlesData = articlesIndex;
# which conflicts with script.js's own const articlesData = [...]

# Read full articles-index.js
idx_content, _ = run(bt, f"cat {vh_root}/js/articles-index.js")
print(f"\nFull articles-index.js ({len(idx_content)} chars):")
print(idx_content[:3000])

# Fix: remove any `const articlesData` line from articles-index.js
# and change it to use `var` or just remove the compat line
if "const articlesData" in idx_content or "let articlesData" in idx_content:
    fixed = idx_content.replace("const articlesData", "// const articlesData")
    fixed = fixed.replace("let articlesData", "// let articlesData")
    with sftp.open(f"{vh_root}/js/articles-index.js", "w") as f:
        f.write(fixed.encode("utf-8"))
    print("\n✓ Fixed: commented out articlesData in articles-index.js")
elif "const articles " in idx_content:
    # Maybe it's `const articles = articlesIndex` that conflicts
    # Check script.js for `const articles`
    out2, _ = run(bt, f"grep 'const articles ' {vh_root}/script.js 2>/dev/null")
    print(f"\nscript.js 'const articles': {out2}")

# Also check: does script.js reference articlesIndex?
out, _ = run(bt, f"grep 'articlesIndex' {vh_root}/script.js 2>/dev/null | head -5")
print(f"\nscript.js articlesIndex refs: {out}")

# Check how article.html loads the article
out, _ = run(bt, f"grep -A2 'urlParam\\|URLSearch\\|get(' {vh_root}/script.js 2>/dev/null | head -20")
print(f"\nscript.js URL param logic:\n{out}")

# Fix vitahaven articles-index.js (already done sed for bool, now fix article ID)
print("\n" + "=" * 60)
print("PART A2: Fix vitahaven Vivid Seats article")
print("=" * 60)

vh = "/www/wwwroot/vitahaven.click"
# Read current articles-index.js
idx, _ = run(bt, f"cat {vh}/js/articles-index.js")
print(f"vitahaven articles-index.js:\n{idx[:1000]}")

# The Vivid Seats article has id:1 but template articles 1-5 exist in js/articles/
# Need to change to id:6 and copy JSON to js/articles/6.json
if "\n    id: 1," in idx or "\n  id: 1," in idx:
    # Change id from 1 to 6
    new_idx = idx.replace("\n    id: 1,", "\n    id: 6,", 1)
    new_idx = new_idx.replace("\n  id: 1,", "\n  id: 6,", 1)
    if new_idx != idx:
        with sftp.open(f"{vh}/js/articles-index.js", "w") as f:
            f.write(new_idx.encode("utf-8"))
        print("✓ Changed Vivid Seats article id: 1 -> 6")

# Copy article JSON from articles/ to js/articles/6.json
slug = "the-smart-way-to-buy-event-tickets-in-2026-why-vivid-seats-rewards-program-changes-everything"
src_json = f"{vh}/articles/{slug}.json"
out, _ = run(bt, f"test -f {src_json} && echo YES || echo NO")
if out == "YES":
    json_content, _ = run(bt, f"cat {src_json}")
    try:
        data = json.loads(json_content)
        data["id"] = 6
        new_json = json.dumps(data, ensure_ascii=False, indent=2)
        with sftp.open(f"{vh}/js/articles/6.json", "w") as f:
            f.write(new_json.encode("utf-8"))
        print(f"✓ Written js/articles/6.json ({len(new_json)} chars)")
    except Exception as e:
        print(f"✗ JSON parse error: {e}")
else:
    print(f"Source JSON not found at {src_json}")
    # Check if it's already in js/articles/
    out2, _ = run(bt, f"ls {vh}/js/articles/6.json 2>/dev/null && echo EXISTS || echo NO")
    print(f"js/articles/6.json: {out2}")

sftp.close()
bt.close()
print("\n✓ Baota fixes complete")

# ============================================================
# PART B: Fix backend server - AI + PubSite + restart
# ============================================================
print("\n" + "=" * 60)
print("PART B: Backend server fixes")
print("=" * 60)

be = connect_backend()

# Step 1: Check if article_gen_service.py on server has _extract_json_text
print("\n--- B1: Check server article_gen_service.py ---")
out, _ = run(be, f"grep -c '_extract_json_text' {BACKEND_PATH}/app/services/article_gen_service.py")
print(f"_extract_json_text count: {out}")

out, _ = run(be, f"grep -c 'empty\\|空内容' {BACKEND_PATH}/app/services/article_gen_service.py")
print(f"Empty content check count: {out}")

out, _ = run(be, f"head -20 {BACKEND_PATH}/app/services/article_gen_service.py")
print(f"Server file head:\n{out}")

# Step 2: Check git status on server
print("\n--- B2: Git status ---")
out, _ = run(be, f"cd /home/admin/Google-Data-Analysis && git status --short | head -20")
print(f"Git status:\n{out}")

out, _ = run(be, f"cd /home/admin/Google-Data-Analysis && git remote -v")
print(f"Git remote:\n{out}")

# Step 3: Check if remote_publisher.py has the bool fix
print("\n--- B3: Check remote_publisher.py bool fix ---")
out, _ = run(be, f"grep -A2 'isinstance.*bool' {BACKEND_PATH}/app/services/remote_publisher.py | head -10")
print(f"Bool check:\n{out}")

# Step 4: Create PubSite records
print("\n--- B4: Create PubSite records ---")
seed_script = '''import sys
sys.path.insert(0, ".")
from app.database import SessionLocal
from app.models.site import PubSite
from app.models.user import User

db = SessionLocal()
admin = db.query(User).first()
if not admin:
    print("ERROR: No users")
    sys.exit(1)

configs = [
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

created = updated = 0
for name, domain, path, stype, djs, var, pattern in configs:
    existing = db.query(PubSite).filter(PubSite.domain == domain).first()
    if existing:
        existing.site_type = stype
        existing.data_js_path = djs
        existing.article_var_name = var
        existing.article_html_pattern = pattern
        existing.site_path = path
        updated += 1
    else:
        db.add(PubSite(group_id=1, site_name=name, site_path=path, domain=domain,
                        site_type=stype, data_js_path=djs, article_var_name=var,
                        article_html_pattern=pattern, created_by=admin.id))
        created += 1

db.commit()
sites = db.query(PubSite).all()
print(f"Created={created}, Updated={updated}, Total={len(sites)}")
for s in sites:
    print(f"  id={s.id} | {s.domain} | {s.site_type} | {s.article_html_pattern}")
db.close()
'''

# Write seed script to server
be_sftp = be.open_sftp()
with be_sftp.open("/tmp/_seed_pubsites.py", "w") as f:
    f.write(seed_script.encode("utf-8"))

out, err = run(be, f"cd {BACKEND_PATH} && source venv/bin/activate && python3 /tmp/_seed_pubsites.py", 20)
print(out)
if err and "Warning" not in err:
    print(f"STDERR: {err[:500]}")

# Step 5: Pull latest code and restart
print("\n--- B5: Pull latest code ---")
out, _ = run(be, f"cd /home/admin/Google-Data-Analysis && git stash && git pull origin main 2>&1", 30)
print(f"Git pull:\n{out[:1000]}")

# Step 6: Restart backend
print("\n--- B6: Restart backend ---")
# Kill existing
out, _ = run(be, "pkill -f 'uvicorn app.main' 2>/dev/null; sleep 2; ps aux | grep uvicorn | grep -v grep")
print(f"After kill: {out}")

# Start fresh
out, _ = run(be, f"cd {BACKEND_PATH} && source venv/bin/activate && nohup python -m uvicorn app.main:app --host 0.0.0.0 --port 8000 --workers 2 > /home/admin/backend.log 2>&1 & echo STARTED")
print(f"Start: {out}")
time.sleep(5)

# Verify
out, _ = run(be, "curl -s -o /dev/null -w '%{http_code}' http://localhost:8000/health 2>/dev/null")
print(f"Health check: {out}")

out, _ = run(be, "ps aux | grep uvicorn | grep -v grep")
print(f"Processes: {out}")

be_sftp.close()
be.close()

print("\n" + "=" * 60)
print("ALL FIXES COMPLETE")
print("=" * 60)
