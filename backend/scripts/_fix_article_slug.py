import paramiko, sys, time
sys.stdout.reconfigure(encoding='utf-8')

ssh = paramiko.SSHClient()
ssh.set_missing_host_key_policy(paramiko.AutoAddPolicy())
ssh.connect("47.239.193.33", username="admin", password="A123456", timeout=10)

sftp = ssh.open_sftp()
with sftp.open("/tmp/fix_slug.py", "w") as f:
    f.write('''
import sys, os, re, json
sys.path.insert(0, "/home/admin/Google-Data-Analysis/backend")
os.chdir("/home/admin/Google-Data-Analysis/backend")

from app.services.remote_publisher import RemotePublisher
from app.database import SessionLocal
from app.models.article import PubArticle

OLD_SLUG = "the-holy-grail-for-40-mature-skin-say-goodbye-to-creasing-and-fine-lines-with-fiera-cosmetics"
NEW_SLUG = "the-holy-grail-for-40-mature-skin-say-goodbye-to-creasing-and-fine-lines-with-fira-cosmetics"

SITE_ROOT = "/www/wwwroot/zontri.top"

# 1. Fix remote articles-index.js
pub = RemotePublisher()
ssh_client = pub._connect()
sftp = ssh_client.open_sftp()

# Update articles-index.js
index_path = f"{SITE_ROOT}/js/articles-index.js"
with sftp.open(index_path, "r") as f:
    content = f.read().decode("utf-8")

if OLD_SLUG in content:
    content = content.replace(OLD_SLUG, NEW_SLUG)
    with sftp.open(index_path, "w") as f:
        f.write(content.encode("utf-8"))
    print(f"[OK] articles-index.js: slug updated")
else:
    print(f"[SKIP] articles-index.js: old slug not found")

# Update 1.json
json_path = f"{SITE_ROOT}/js/articles/1.json"
try:
    with sftp.open(json_path, "r") as f:
        jdata = json.loads(f.read().decode("utf-8"))
    if jdata.get("slug") == OLD_SLUG:
        jdata["slug"] = NEW_SLUG
        with sftp.open(json_path, "w") as f:
            f.write(json.dumps(jdata, ensure_ascii=False, indent=2).encode("utf-8"))
        print(f"[OK] 1.json: slug updated")
    else:
        print(f"[SKIP] 1.json: slug is {jdata.get('slug')}")
except Exception as e:
    print(f"[ERROR] 1.json: {e}")

# Rename image directory
old_img = f"{SITE_ROOT}/image/post-{OLD_SLUG}"
new_img = f"{SITE_ROOT}/image/post-{NEW_SLUG}"
try:
    sftp.stat(old_img)
    sftp.rename(old_img, new_img)
    print(f"[OK] Image dir renamed")
    # Also update image paths in articles-index.js and 1.json
    with sftp.open(index_path, "r") as f:
        content = f.read().decode("utf-8")
    content = content.replace(f"post-{OLD_SLUG}", f"post-{NEW_SLUG}")
    with sftp.open(index_path, "w") as f:
        f.write(content.encode("utf-8"))
    
    with sftp.open(json_path, "r") as f:
        jdata = json.loads(f.read().decode("utf-8"))
    jdata_str = json.dumps(jdata, ensure_ascii=False, indent=2)
    jdata_str = jdata_str.replace(f"post-{OLD_SLUG}", f"post-{NEW_SLUG}")
    with sftp.open(json_path, "w") as f:
        f.write(jdata_str.encode("utf-8"))
    print(f"[OK] Image paths updated in JS files")
except FileNotFoundError:
    print(f"[SKIP] Image dir not found at old path")
except Exception as e:
    print(f"[ERROR] Image dir: {e}")

sftp.close()
ssh_client.close()

# 2. Fix database
db = SessionLocal()
article = db.query(PubArticle).filter(PubArticle.id == 14).first()
if article:
    print(f"\\nDB before: slug={article.slug}, site_slug={article.site_article_slug}")
    article.slug = NEW_SLUG
    article.site_article_slug = NEW_SLUG
    db.commit()
    print(f"DB after: slug={article.slug}, site_slug={article.site_article_slug}")
else:
    print("Article id=14 not found")
db.close()

print("\\nDone!")
''')
sftp.close()

stdin, stdout, stderr = ssh.exec_command(
    "cd /home/admin/Google-Data-Analysis/backend && source venv/bin/activate && python3 /tmp/fix_slug.py 2>&1",
    timeout=30
)
print(stdout.read().decode('utf-8', errors='replace'), flush=True)

ssh.close()
