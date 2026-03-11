import paramiko
import sys, io
sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding='utf-8', errors='replace')

ssh = paramiko.SSHClient()
ssh.set_missing_host_key_policy(paramiko.AutoAddPolicy())
ssh.connect('47.239.193.33', port=22, username='admin', password='A123456', timeout=15)

# Check backend DB for this article
print("=== Search DB for 1st phorm article ===")
db_script = '''
import sys, os, json
sys.path.insert(0, '/home/admin/Google-Data-Analysis/backend')
os.chdir('/home/admin/Google-Data-Analysis/backend')

from app.database import SessionLocal
from app.models.article import Article

db = SessionLocal()
try:
    # Search for 1st phorm articles
    articles = db.query(Article).filter(
        Article.title.ilike('%1st%phorm%') | 
        Article.title.ilike('%protein%powder%') |
        Article.slug.ilike('%1st-phorm%') |
        Article.slug.ilike('%protein-powder%')
    ).all()
    
    if not articles:
        print("No matching articles found in DB")
        # Show recent articles
        recent = db.query(Article).order_by(Article.id.desc()).limit(10).all()
        print(f"\\nRecent {len(recent)} articles:")
        for a in recent:
            print(f"  id={a.id} slug='{a.slug}' title='{a.title[:60]}' status={a.status} site={getattr(a, 'site_domain', 'N/A')}")
    else:
        for a in articles:
            print(f"ID: {a.id}")
            print(f"Title: {a.title}")
            print(f"Slug: {a.slug}")
            print(f"Status: {a.status}")
            print(f"Site: {getattr(a, 'site_domain', 'N/A')}")
            print(f"Category: {getattr(a, 'category', 'N/A')}")
            print(f"Created: {a.created_at}")
            content = a.content or ''
            print(f"Content length: {len(content)}")
            
            # Count links
            import re
            links = re.findall(r'<a\\s+[^>]*href=["\\'](.*?)["\\'\\s][^>]*>', content)
            print(f"Links: {len(links)}")
            for l in links[:10]:
                print(f"  {l[:120]}")
            print()
finally:
    db.close()
'''

sftp = ssh.open_sftp()
with sftp.open('/tmp/check_db.py', 'w') as f:
    f.write(db_script)
sftp.close()

stdin, stdout, stderr = ssh.exec_command(
    'cd /home/admin/Google-Data-Analysis/backend && source venv/bin/activate && python /tmp/check_db.py 2>&1'
)
stdout.channel.settimeout(20)
try:
    print(stdout.read().decode()[-3000:])
except:
    print("(timeout)")

# Also check the remote_publisher to understand how articles get deployed
print("\n=== remote_publisher.py - publish logic ===")
stdin, stdout, stderr = ssh.exec_command(
    "grep -n 'def publish\\|articles-index\\|articles.*json\\|zontri' /home/admin/Google-Data-Analysis/backend/app/services/remote_publisher.py | head -20"
)
print(stdout.read().decode())

ssh.close()
