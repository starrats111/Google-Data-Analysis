"""
All-in-one fix script:
1. Fix AI service (deploy latest article_gen_service.py)
2. Create PubSite records in backend DB
3. Fix bloomroots articlesData conflict on Baota
4. Fix vitahaven Vivid Seats article on Baota
5. Restart backend
"""
import paramiko, sys, json, os, time
sys.stdout.reconfigure(encoding='utf-8')

# === Backend server (47.239.193.33) ===
BACKEND_HOST = "47.239.193.33"
BACKEND_USER = "admin"
BACKEND_PASS = "A123456"
BACKEND_PATH = "/home/admin/Google-Data-Analysis/backend"

# === Baota server (52.74.221.116) ===
BAOTA_HOST = "52.74.221.116"
BAOTA_KEY = r"C:\Users\Administrator\Desktop\密钥\awssg0306.pem"

def connect_backend():
    ssh = paramiko.SSHClient()
    ssh.set_missing_host_key_policy(paramiko.AutoAddPolicy())
    ssh.connect(BACKEND_HOST, 22, BACKEND_USER, password=BACKEND_PASS, timeout=15)
    return ssh

def connect_baota():
    pkey = paramiko.RSAKey.from_private_key_file(BAOTA_KEY)
    ssh = paramiko.SSHClient()
    ssh.set_missing_host_key_policy(paramiko.AutoAddPolicy())
    ssh.connect(BAOTA_HOST, 22, "ubuntu", pkey=pkey, timeout=15)
    return ssh

def run(ssh, cmd, t=30):
    stdin, stdout, stderr = ssh.exec_command(cmd, timeout=t)
    stdout.channel.recv_exit_status()
    out = stdout.read().decode('utf-8', errors='replace').strip()
    err = stderr.read().decode('utf-8', errors='replace').strip()
    return out, err

# ============================================================
# PART A: Backend server fixes
# ============================================================
print("=" * 60)
print("PART A: Backend server (47.239.193.33)")
print("=" * 60)

be = connect_backend()

# A1: Upload latest article_gen_service.py
print("\n--- A1: Upload article_gen_service.py ---")
local_ai = os.path.join(os.path.dirname(__file__), "..", "app", "services", "article_gen_service.py")
local_ai = os.path.abspath(local_ai)
remote_ai = f"{BACKEND_PATH}/app/services/article_gen_service.py"
sftp_be = be.open_sftp()
sftp_be.put(local_ai, remote_ai)
print(f"Uploaded: {local_ai} -> {remote_ai}")

# A2: Upload remote_publisher.py
print("\n--- A2: Upload remote_publisher.py ---")
local_rp = os.path.join(os.path.dirname(__file__), "..", "app", "services", "remote_publisher.py")
local_rp = os.path.abspath(local_rp)
remote_rp = f"{BACKEND_PATH}/app/services/remote_publisher.py"
sftp_be.put(local_rp, remote_rp)
print(f"Uploaded: {local_rp} -> {remote_rp}")

# A3: Upload articles.py (URL fix)
print("\n--- A3: Upload articles.py ---")
local_art = os.path.join(os.path.dirname(__file__), "..", "app", "api", "articles.py")
local_art = os.path.abspath(local_art)
remote_art = f"{BACKEND_PATH}/app/api/articles.py"
sftp_be.put(local_art, remote_art)
print(f"Uploaded: {local_art} -> {remote_art}")

# A4: Upload site.py model
print("\n--- A4: Upload site.py ---")
local_site = os.path.join(os.path.dirname(__file__), "..", "app", "models", "site.py")
local_site = os.path.abspath(local_site)
remote_site = f"{BACKEND_PATH}/app/models/site.py"
sftp_be.put(local_site, remote_site)
print(f"Uploaded: {local_site} -> {remote_site}")

sftp_be.close()

# A5: Create PubSite records
print("\n--- A5: Create PubSite records ---")
SITES_CONFIG = [
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

seed_py = '''import sys
sys.path.insert(0, ".")
from app.database import SessionLocal
from app.models.site import PubSite
from app.models.user import User

db = SessionLocal()
admin = db.query(User).first()
if not admin:
    print("ERROR: No users")
    sys.exit(1)
admin_id = admin.id
print(f"Admin: id={admin_id}, username={admin.username}")

configs = ''' + repr(SITES_CONFIG) + '''

created = 0
updated = 0
for name, domain, path, stype, djs, var, pattern in configs:
    existing = db.query(PubSite).filter(PubSite.domain == domain).first()
    if existing:
        existing.site_type = stype
        existing.data_js_path = djs
        existing.article_var_name = var
        existing.article_html_pattern = pattern
        existing.site_path = path
        updated += 1
        print(f"  Updated: {domain} (id={existing.id})")
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
        print(f"  Created: {domain}")

db.commit()
all_sites = db.query(PubSite).all()
print(f"Result: created={created}, updated={updated}, total={len(all_sites)}")
for s in all_sites:
    print(f"  id={s.id} | {s.domain} | type={s.site_type} | pattern={s.article_html_pattern}")
db.close()
'''

sftp_be2 = be.open_sftp()
with sftp_be2.open("/tmp/_seed_pubsites.py", "w") as f:
    f.write(seed_py.encode("utf-8"))
sftp_be2.close()

out, err = run(be, f"cd {BACKEND_PATH} && source venv/bin/activate && python3 /tmp/_seed_pubsites.py", 20)
print(out)
if err:
    print(f"STDERR: {err[:500]}")

# A6: Restart backend
print("\n--- A6: Restart backend ---")
# Kill existing
out, _ = run(be, "pkill -f 'uvicorn app.main' || true")
time.sleep(2)
out, _ = run(be, "ps aux | grep uvicorn | grep -v grep")
print(f"After kill: {out or 'clean'}")

# Start fresh
out, _ = run(be, f"cd {BACKEND_PATH} && source venv/bin/activate && nohup python -m uvicorn app.main:app --host 0.0.0.0 --port 8000 --workers 2 > /home/admin/backend.log 2>&1 & echo STARTED")
print(f"Start: {out}")
time.sleep(5)

# Verify
out, _ = run(be, "ps aux | grep uvicorn | grep -v grep")
print(f"Running: {'YES' if out else 'NO'}")
out, _ = run(be, 'curl -s -o /dev/null -w "%{http_code}" http://localhost:8000/health')
print(f"Health check: {out}")

be.close()

# ============================================================
# PART B: Baota server fixes
# ============================================================
print("\n" + "=" * 60)
print("PART B: Baota server (52.74.221.116)")
print("=" * 60)

bt = connect_baota()
sftp_bt = bt.open_sftp()

# B1: Fix bloomroots - articlesData conflict
# The problem: script.js declares `const articlesData = [...]` AND articles-index.js also gets loaded
# Solution: In articles-index.js, use `var articlesIndex` instead of `const articlesIndex` and
# make script.js reference articlesIndex instead of its own articlesData
print("\n--- B1: Fix bloomroots articlesData conflict ---")
br_root = "/www/wwwroot/bloomroots.top"

# Read current articles-index.js
try:
    with sftp_bt.open(f"{br_root}/js/articles-index.js", "r") as f:
        br_idx = f.read().decode("utf-8")
    print(f"Read articles-index.js ({len(br_idx)} chars)")
    
    # Check if it has const articlesData or const articlesIndex
    if "const articlesIndex" in br_idx or "const articlesData" in br_idx:
        # Replace const with var to avoid redeclaration conflict with script.js
        br_idx_new = br_idx.replace("const articlesIndex", "var articlesIndex")
        br_idx_new = br_idx_new.replace("const articles =", "var articles =")
        
        # Also add articlesData alias if not present
        if "articlesData" not in br_idx_new:
            br_idx_new = br_idx_new.rstrip()
            if not br_idx_new.endswith("\n"):
                br_idx_new += "\n"
            br_idx_new += "\n// 兼容 script.js\nvar articlesData = articlesIndex;\n"
        
        with sftp_bt.open(f"{br_root}/js/articles-index.js", "w") as f:
            f.write(br_idx_new.encode("utf-8"))
        print("Fixed: const -> var, added articlesData alias")
except Exception as e:
    print(f"Error fixing bloomroots articles-index.js: {e}")

# Now fix script.js: change `const articlesData = [...]` to use the one from articles-index.js
try:
    with sftp_bt.open(f"{br_root}/script.js", "r") as f:
        br_script = f.read().decode("utf-8")
    print(f"Read script.js ({len(br_script)} chars)")
    
    if "const articlesData" in br_script:
        # Find and remove the entire articlesData array declaration from script.js
        # It starts with "const articlesData = [" and ends with "];"
        import re
        # Match the full array: const articlesData = [...];
        pattern = r'(?:const|let|var)\s+articlesData\s*=\s*\['
        match = re.search(pattern, br_script)
        if match:
            start = match.start()
            # Find matching ]
            bracket_start = match.end() - 1
            depth = 0
            i = bracket_start
            while i < len(br_script):
                ch = br_script[i]
                if ch == '[':
                    depth += 1
                elif ch == ']':
                    depth -= 1
                    if depth == 0:
                        break
                elif ch in ('"', "'", '`'):
                    quote = ch
                    i += 1
                    while i < len(br_script) and br_script[i] != quote:
                        if br_script[i] == '\\':
                            i += 1
                        i += 1
                i += 1
            end = i + 1
            # Skip trailing semicolon
            if end < len(br_script) and br_script[end] == ';':
                end += 1
            
            # Replace with comment + reference to articles-index.js
            replacement = "// articlesData is now loaded from js/articles-index.js\n"
            br_script_new = br_script[:start] + replacement + br_script[end:]
            
            with sftp_bt.open(f"{br_root}/script.js", "w") as f:
                f.write(br_script_new.encode("utf-8"))
            print(f"Fixed script.js: removed inline articlesData ({end - start} chars)")
        else:
            print("WARNING: Could not find articlesData array pattern in script.js")
    else:
        print("script.js does not have const articlesData, checking for var...")
        if "var articlesData" in br_script or "let articlesData" in br_script:
            br_script_new = br_script.replace("var articlesData", "// var articlesData (from articles-index.js)")
            br_script_new = br_script_new.replace("let articlesData", "// let articlesData (from articles-index.js)")
            print("Commented out var/let articlesData")
except Exception as e:
    print(f"Error fixing bloomroots script.js: {e}")

# B2: Fix vitahaven - Vivid Seats article ID
print("\n--- B2: Fix vitahaven Vivid Seats article ---")
vh_root = "/www/wwwroot/vitahaven.click"

# Fix articles-index.js: Python bool -> JS bool already done, check id
try:
    with sftp_bt.open(f"{vh_root}/js/articles-index.js", "r") as f:
        vh_idx = f.read().decode("utf-8")
    
    # Fix Python booleans
    vh_idx = vh_idx.replace("hasProducts: False", "hasProducts: false")
    vh_idx = vh_idx.replace("hasProducts: True", "hasProducts: true")
    
    # The Vivid Seats article has id: 1 but template articles 1-5 exist in js/articles/
    # Change to id: 6
    if "\n    id: 1," in vh_idx and "vivid-seats" in vh_idx:
        # Only replace the first occurrence (the Vivid Seats entry)
        vh_idx = vh_idx.replace("\n    id: 1,", "\n    id: 6,", 1)
        print("Changed Vivid Seats id: 1 -> 6")
    
    with sftp_bt.open(f"{vh_root}/js/articles-index.js", "w") as f:
        f.write(vh_idx.encode("utf-8"))
    print("Updated articles-index.js")
except Exception as e:
    print(f"Error: {e}")

# Copy article JSON to js/articles/6.json
try:
    slug = "the-smart-way-to-buy-event-tickets-in-2026-why-vivid-seats-rewards-program-changes-everything"
    src = f"{vh_root}/articles/{slug}.json"
    
    with sftp_bt.open(src, "r") as f:
        vs_data = json.loads(f.read().decode("utf-8"))
    
    vs_data["id"] = 6
    new_json = json.dumps(vs_data, ensure_ascii=False, indent=2)
    
    with sftp_bt.open(f"{vh_root}/js/articles/6.json", "w") as f:
        f.write(new_json.encode("utf-8"))
    print(f"Created js/articles/6.json ({len(new_json)} chars)")
except Exception as e:
    print(f"Error copying article JSON: {e}")

# B3: Fix all sites - ensure articles-index.js uses proper JS booleans
print("\n--- B3: Fix all sites JS booleans ---")
for domain in ["zontri.top", "vitasphere.top", "everydayhaven.top", "quiblo.top", "allurahub.top"]:
    path = f"/www/wwwroot/{domain}/js/articles-index.js"
    try:
        with sftp_bt.open(path, "r") as f:
            content = f.read().decode("utf-8")
        changed = False
        for old, new in [("hasProducts: False", "hasProducts: false"),
                         ("hasProducts: True", "hasProducts: true"),
                         ("featured: False", "featured: false"),
                         ("featured: True", "featured: true")]:
            if old in content:
                content = content.replace(old, new)
                changed = True
        if changed:
            with sftp_bt.open(path, "w") as f:
                f.write(content.encode("utf-8"))
            print(f"  {domain}: fixed Python booleans")
        else:
            print(f"  {domain}: OK")
    except Exception as e:
        print(f"  {domain}: {e}")

sftp_bt.close()
bt.close()

print("\n" + "=" * 60)
print("ALL DONE!")
print("=" * 60)
