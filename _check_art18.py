import paramiko
import sys, io, json, re
sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding='utf-8', errors='replace')

ssh = paramiko.SSHClient()
ssh.set_missing_host_key_policy(paramiko.AutoAddPolicy())
ssh.connect('47.239.193.33', port=22, username='admin', password='A123456', timeout=15)

db_script = '''
import sys, os, json, re
sys.path.insert(0, '/home/admin/Google-Data-Analysis/backend')
os.chdir('/home/admin/Google-Data-Analysis/backend')
from app.database import SessionLocal
from sqlalchemy import text

db = SessionLocal()
try:
    # Get article 18 full details
    result = db.execute(text("SELECT * FROM pub_articles WHERE id=18"))
    cols = result.keys()
    row = result.fetchone()
    if row:
        d = dict(zip(cols, row))
        print(f"=== Article 18 ===")
        print(f"Title: {d['title']}")
        print(f"Slug: {d['slug']}")
        print(f"Status: {d['status']}")
        print(f"Site ID: {d['site_id']}")
        print(f"Published to site: {d.get('published_to_site')}")
        print(f"Site article slug: {d.get('site_article_slug')}")
        print(f"Language: {d.get('language')}")
        print(f"Merchant URL: {d.get('merchant_url')}")
        print(f"Tracking link: {str(d.get('tracking_link', ''))[:120]}")
        
        content = d.get('content', '')
        print(f"Content length: {len(content)} chars")
        
        # Count links
        links = re.findall(r'<a\\s+[^>]*href=["\\'](.*?)["\\'\\s][^>]*>', content)
        print(f"Total links: {len(links)}")
        for i, l in enumerate(links):
            print(f"  Link {i+1}: {l[:150]}")
        
        # Show content preview
        print(f"\\nContent (first 1500 chars):")
        print(content[:1500])
        print(f"\\n... (middle truncated) ...\\n")
        print(f"Content (last 500 chars):")
        print(content[-500:])
    
    # Check site 13
    print(f"\\n=== Site 13 ===")
    result = db.execute(text("SELECT * FROM pub_sites WHERE id=13"))
    cols = result.keys()
    row = result.fetchone()
    if row:
        d = dict(zip(cols, row))
        for k, v in d.items():
            print(f"  {k}: {v}")
    
    # Check publish logs for article 18
    print(f"\\n=== Publish logs for article 18 ===")
    result = db.execute(text("SELECT * FROM luchu_publish_logs WHERE article_id=18 ORDER BY id DESC LIMIT 5"))
    cols = result.keys()
    rows = result.fetchall()
    if rows:
        for row in rows:
            d = dict(zip(cols, row))
            print(f"  log id={d['id']} status={d['status']} file={d.get('file_path')} error={str(d.get('error_message', ''))[:100]}")
    else:
        print("  No publish logs found!")
        
finally:
    db.close()
'''

sftp = ssh.open_sftp()
with sftp.open('/tmp/check_art18.py', 'w') as f:
    f.write(db_script)
sftp.close()

stdin, stdout, stderr = ssh.exec_command(
    'cd /home/admin/Google-Data-Analysis/backend && source venv/bin/activate && python /tmp/check_art18.py 2>&1'
)
stdout.channel.settimeout(20)
try:
    print(stdout.read().decode()[-5000:])
except:
    print("(timeout)")

ssh.close()
