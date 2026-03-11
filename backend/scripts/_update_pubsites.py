"""Update PubSite records with correct architecture for ALL sites"""
import paramiko, sys, time
sys.stdout.reconfigure(encoding='utf-8')

ssh = paramiko.SSHClient()
ssh.set_missing_host_key_policy(paramiko.AutoAddPolicy())
ssh.connect('47.239.193.33', 22, 'admin', password='A123456', timeout=15)

BACKEND = "/home/admin/Google-Data-Analysis/backend"

# Complete site config with correct architecture
SITES_CONFIG = [
    # B1-SPA: articles-index.js + js/articles/{id}.json
    ("VitaHaven", "vitahaven.click", "/www/wwwroot/vitahaven.click", "articles_index", "js/articles-index.js", "articlesIndex", "article.html?title={slug}"),
    ("Zontri", "zontri.top", "/www/wwwroot/zontri.top", "articles_index", "js/articles-index.js", "articlesIndex", "article.html?title={slug}"),
    ("VitaSphere", "vitasphere.top", "/www/wwwroot/vitasphere.top", "articles_index", "js/articles-index.js", "articlesIndex", "article.html?slug={slug}"),
    ("EverydayHaven", "everydayhaven.top", "/www/wwwroot/everydayhaven.top", "articles_index", "js/articles-index.js", "articlesIndex", "article.html?name={slug}"),
    ("BloomRoots", "bloomroots.top", "/www/wwwroot/bloomroots.top", "articles_index", "js/articles-index.js", "articlesIndex", "article.html?title={slug}"),
    ("Quiblo", "quiblo.top", "/www/wwwroot/quiblo.top", "articles_index", "js/articles-index.js", "articlesIndex", "article.html?title={slug}"),
    ("AlluraHub", "allurahub.top", "/www/wwwroot/allurahub.top", "articles_index", "js/articles-index.js", "articlesIndex", "article.html?title={slug}"),
    # B2-inline: js/main.js with articlesData
    ("Mevora", "mevora.top", "/www/wwwroot/mevora.top", "articles_index", "js/articles-index.js", "articlesIndex", "article.html?title={slug}"),
    # Static HTML: each article is a separate .html file
    ("Kivanta", "kivanta.top", "/www/wwwroot/kivanta.top", "articles_inline", "js/main.js", "articles", "{slug}.html"),
    ("AuraBloom", "aura-bloom.top", "/www/wwwroot/aura-bloom.top", "posts_assets_js", "assets/js/main.js", "posts", "post-{slug}.html"),
    ("NovaNest", "novanest.one", "/www/wwwroot/novanest.one", "posts_assets_js", "assets/js/main.js", "posts", "post-{slug}.html"),
    ("KeyMint", "keymint.co", "/www/wwwroot/keymint.co", "posts_scripts", "assets/js/posts.js", "posts", "post-{slug}.html"),
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
        existing.site_name = name
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
print(f"\\nResult: created={created}, updated={updated}, total={len(all_sites)}")
for s in all_sites:
    print(f"  id={s.id} | {s.domain} | type={s.site_type} | pattern={s.article_html_pattern}")
db.close()
'''

sftp = ssh.open_sftp()
with sftp.open("/tmp/_seed_pubsites_final.py", "w") as f:
    f.write(seed_py.encode("utf-8"))
sftp.close()

out_cmd = f"cd {BACKEND} && source venv/bin/activate && python3 /tmp/_seed_pubsites_final.py"
stdin, stdout, stderr = ssh.exec_command(out_cmd, timeout=20)
stdout.channel.recv_exit_status()
out = stdout.read().decode('utf-8', errors='replace').strip()
err = stderr.read().decode('utf-8', errors='replace').strip()
print(out)
if err:
    print(f"STDERR: {err[:500]}")

ssh.close()
print("\nDone!")
