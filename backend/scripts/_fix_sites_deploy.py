"""Fix BloomRoots + all sites: 
1. Fix articlesData/articles duplicate declaration in articles-index.js
2. Create PubSite records on backend server
3. Fix vitahaven Vivid Seats article
"""
import paramiko, sys, json
sys.stdout.reconfigure(encoding='utf-8')

# === Connect to Baota server (52.74.221.116) ===
pkey = paramiko.RSAKey.from_private_key_file(r"C:\Users\Administrator\Desktop\密钥\awssg0306.pem")
bt = paramiko.SSHClient()
bt.set_missing_host_key_policy(paramiko.AutoAddPolicy())
bt.connect("52.74.221.116", 22, "ubuntu", pkey=pkey, timeout=15)
bt_sftp = bt.open_sftp()

def bt_r(cmd, t=15):
    stdin, stdout, stderr = bt.exec_command(cmd, timeout=t)
    stdout.channel.recv_exit_status()
    return stdout.read().decode('utf-8', errors='replace').strip()

# === Connect to Backend server (47.239.193.33) ===
be = paramiko.SSHClient()
be.set_missing_host_key_policy(paramiko.AutoAddPolicy())
be.connect('47.239.193.33', port=22, username='admin', password='A123456', timeout=15)

def be_r(cmd, t=30):
    stdin, stdout, stderr = be.exec_command(cmd, timeout=t)
    stdout.channel.recv_exit_status()
    out = stdout.read().decode('utf-8', errors='replace').strip()
    err = stderr.read().decode('utf-8', errors='replace').strip()
    return out, err

BACKEND = "/home/admin/Google-Data-Analysis/backend"

# ============================================================
# Step 1: Fix articles-index.js alias conflicts on ALL sites
# ============================================================
print("=== Step 1: Fix articles-index.js alias conflicts ===")

sites_to_fix = [
    "bloomroots.top",
    "vitahaven.click",
    "zontri.top",
    "vitasphere.top",
    "everydayhaven.top",
    "quiblo.top",
    "allurahub.top",
]

for domain in sites_to_fix:
    idx_path = f"/www/wwwroot/{domain}/js/articles-index.js"
    try:
        with bt_sftp.open(idx_path, "r") as f:
            content = f.read().decode("utf-8")
        
        changed = False
        # Fix: const articlesData = articlesIndex; -> (remove or use var)
        if "const articlesData = articlesIndex" in content:
            # BloomRoots: script.js has its own const articlesData, so remove this alias
            content = content.replace(
                "const articlesData = articlesIndex;",
                "// articlesData provided by script.js"
            )
            changed = True
            print(f"  {domain}: removed 'const articlesData = articlesIndex' (conflicts with script.js)")
        
        # Fix: const articles = articlesIndex; -> var (in case other scripts also declare it)
        if "const articles = articlesIndex" in content:
            content = content.replace(
                "const articles = articlesIndex;",
                "var articles = articlesIndex;"
            )
            changed = True
            print(f"  {domain}: changed 'const articles' -> 'var articles'")
        
        if changed:
            with bt_sftp.open(idx_path, "w") as f:
                f.write(content.encode("utf-8"))
            print(f"  {domain}: ✓ saved")
        else:
            print(f"  {domain}: no conflicts found")
    except FileNotFoundError:
        print(f"  {domain}: articles-index.js not found, skipping")
    except Exception as e:
        print(f"  {domain}: error - {e}")

# ============================================================
# Step 2: Fix vitahaven Vivid Seats article (id conflict)
# ============================================================
print("\n=== Step 2: Fix vitahaven Vivid Seats article ===")
vh = "/www/wwwroot/vitahaven.click"

# Read articles-index.js
with bt_sftp.open(f"{vh}/js/articles-index.js", "r") as f:
    vh_idx = f.read().decode("utf-8")

# The Vivid Seats article was added with id: 1, but template articles 1-5 exist in js/articles/
# Need to change to id: 6
if "id: 1," in vh_idx and "vivid-seats" in vh_idx.lower():
    # Only replace the first occurrence (the Vivid Seats entry)
    vh_idx = vh_idx.replace("  id: 1,", "  id: 6,", 1)
    with bt_sftp.open(f"{vh}/js/articles-index.js", "w") as f:
        f.write(vh_idx.encode("utf-8"))
    print("  Updated Vivid Seats id: 1 -> 6 in articlesIndex")

# Copy the article JSON to js/articles/6.json
try:
    slug = "the-smart-way-to-buy-event-tickets-in-2026-why-vivid-seats-rewards-program-changes-everything"
    src = f"{vh}/articles/{slug}.json"
    with bt_sftp.open(src, "r") as f:
        vs_json = json.loads(f.read().decode("utf-8"))
    vs_json["id"] = 6
    dst = f"{vh}/js/articles/6.json"
    with bt_sftp.open(dst, "w") as f:
        f.write(json.dumps(vs_json, ensure_ascii=False, indent=2).encode("utf-8"))
    print(f"  Copied article JSON to js/articles/6.json ({len(json.dumps(vs_json))} chars)")
except FileNotFoundError:
    print("  Vivid Seats JSON not found in articles/ dir, checking js/articles/...")
    try:
        with bt_sftp.open(f"{vh}/js/articles/6.json", "r") as f:
            print(f"  js/articles/6.json already exists ({len(f.read())} bytes)")
    except FileNotFoundError:
        print("  WARNING: No Vivid Seats JSON found anywhere!")
except Exception as e:
    print(f"  Error: {e}")

# Verify
print("\n  Verification:")
print(f"  articles-index.js first 500 chars:")
with bt_sftp.open(f"{vh}/js/articles-index.js", "r") as f:
    print(f"  {f.read().decode('utf-8')[:500]}")

# ============================================================
# Step 3: Create PubSite records on backend server
# ============================================================
print("\n=== Step 3: Create PubSite records ===")

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

be_sftp = be.open_sftp()
with be_sftp.open("/tmp/_seed_pubsites.py", "w") as f:
    f.write(seed_py.encode("utf-8"))

out, err = be_r(f"cd {BACKEND} && source venv/bin/activate && python3 /tmp/_seed_pubsites.py", 20)
print(out)
if err:
    print(f"STDERR: {err[:500]}")

be_sftp.close()
bt_sftp.close()
bt.close()
be.close()
print("\nDone!")
