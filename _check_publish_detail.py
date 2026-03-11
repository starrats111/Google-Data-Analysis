import paramiko
import sys, io, json
sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding='utf-8', errors='replace')

ssh = paramiko.SSHClient()
ssh.set_missing_host_key_policy(paramiko.AutoAddPolicy())
ssh.connect('47.239.193.33', port=22, username='admin', password='A123456', timeout=15)

db_script = '''
import sys, os
sys.path.insert(0, '/home/admin/Google-Data-Analysis/backend')
os.chdir('/home/admin/Google-Data-Analysis/backend')
from app.database import SessionLocal
from sqlalchemy import text

db = SessionLocal()
try:
    # Article 18 images
    print("=== Article 18 images (pub_article_images) ===")
    result = db.execute(text("SELECT * FROM pub_article_images WHERE article_id=18"))
    cols = list(result.keys())
    rows = result.fetchall()
    print(f"Columns: {cols}")
    for row in rows:
        d = dict(zip(cols, row))
        print(f"  id={d.get('id')} pos={d.get('position')} type={d.get('image_type')} url={str(d.get('url',''))[:120]}")

    # Article 18 full record
    print("\\n=== Article 18 key fields ===")
    result = db.execute(text("SELECT id, title, slug, status, site_id, published_to_site, featured_image, site_article_slug, created_at, published_at FROM pub_articles WHERE id=18"))
    cols = list(result.keys())
    row = result.fetchone()
    if row:
        d = dict(zip(cols, row))
        for k, v in d.items():
            print(f"  {k}: {v}")

    # Check site 13 config
    print("\\n=== Site 13 (zontri.top) config ===")
    result = db.execute(text("SELECT * FROM pub_sites WHERE id=13"))
    cols = list(result.keys())
    row = result.fetchone()
    if row:
        d = dict(zip(cols, row))
        for k, v in d.items():
            if v is not None:
                print(f"  {k}: {v}")

    # Check zontri.top file system
    print("\\n=== zontri.top articles directory ===")
finally:
    db.close()
'''

sftp = ssh.open_sftp()
with sftp.open('/tmp/check_art18_v2.py', 'w') as f:
    f.write(db_script)
sftp.close()

stdin, stdout, stderr = ssh.exec_command(
    'cd /home/admin/Google-Data-Analysis/backend && source venv/bin/activate && python /tmp/check_art18_v2.py 2>&1'
)
stdout.channel.settimeout(15)
try:
    print(stdout.read().decode()[-3000:])
except:
    print("(timeout)")

# Check file system
print("\n=== zontri.top file system ===")
stdin, stdout, stderr = ssh.exec_command("ls -la /www/wwwroot/zontri.top/js/articles/ 2>/dev/null")
print(stdout.read().decode())

stdin, stdout, stderr = ssh.exec_command("ls -la /www/wwwroot/zontri.top/image/ 2>/dev/null | head -20")
print(stdout.read().decode())

# Check if article-18 image dir exists
stdin, stdout, stderr = ssh.exec_command("ls -la /www/wwwroot/zontri.top/image/post-why-choose-1st-phorm-protein-powders/ 2>/dev/null")
out = stdout.read().decode()
print(f"Article 18 images dir: {out if out else 'NOT FOUND'}")

# Check backend log for publish errors
print("\n=== Backend log - publish errors ===")
stdin, stdout, stderr = ssh.exec_command("grep -i 'publish\\|远程发布\\|B1\\|articles.*index' /home/admin/backend.log | tail -30")
print(stdout.read().decode()[-2000:])

ssh.close()
