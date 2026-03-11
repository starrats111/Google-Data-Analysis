import paramiko, sys
sys.stdout.reconfigure(encoding='utf-8')

ssh = paramiko.SSHClient()
ssh.set_missing_host_key_policy(paramiko.AutoAddPolicy())
ssh.connect("47.239.193.33", username="admin", password="A123456", timeout=10)

def run(cmd, timeout=15):
    stdin, stdout, stderr = ssh.exec_command(cmd, timeout=timeout)
    return stdout.read().decode('utf-8', errors='replace'), stderr.read().decode('utf-8', errors='replace')

# Get full slug values
out, _ = run("""cd /home/admin/Google-Data-Analysis/backend && source venv/bin/activate && python3 -c "
from app.database import SessionLocal
from app.models.article import PubArticle
db = SessionLocal()
a = db.query(PubArticle).filter(PubArticle.id == 14).first()
print('slug:', a.slug)
print('site_article_slug:', a.site_article_slug)
print('title:', a.title)
print()
print('slug == site_article_slug:', a.slug == a.site_article_slug)
print('slug length:', len(a.slug))
print('site_slug length:', len(a.site_article_slug) if a.site_article_slug else 0)
db.close()
" 2>&1""")
print(out, flush=True)

# Also check slug generation
out, _ = run("""cd /home/admin/Google-Data-Analysis/backend && source venv/bin/activate && python3 -c "
from app.services.remote_publisher import RemotePublisher
pub = RemotePublisher()
test_title = 'The Holy Grail for 40+ Mature Skin: Say Goodbye to Creasing and Fine Lines with Fiera Cosmetics'
slug = pub._slugify(test_title) if hasattr(pub, '_slugify') else 'no _slugify method'
print('Test slugify:', slug)
" 2>&1""")
print("Slugify test:", out, flush=True)

ssh.close()
