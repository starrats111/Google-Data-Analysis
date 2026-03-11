import paramiko
import sys, io
sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding='utf-8', errors='replace')

ssh = paramiko.SSHClient()
ssh.set_missing_host_key_policy(paramiko.AutoAddPolicy())
ssh.connect('47.239.193.33', port=22, username='admin', password='A123456', timeout=15)

# Find the correct model name
print("=== Article model ===")
stdin, stdout, stderr = ssh.exec_command(
    "grep -n 'class.*Model\\|class.*Base\\|tablename' /home/admin/Google-Data-Analysis/backend/app/models/article.py | head -20"
)
print(stdout.read().decode())

# Search DB directly with sqlite/postgres
print("\n=== DB type ===")
stdin, stdout, stderr = ssh.exec_command(
    "grep 'DATABASE_URL\\|SQLALCHEMY' /home/admin/Google-Data-Analysis/backend/.env 2>/dev/null; "
    "grep 'DATABASE_URL\\|SQLALCHEMY' /home/admin/Google-Data-Analysis/backend/app/config.py 2>/dev/null | head -5"
)
print(stdout.read().decode())

# Try to find article via SQL
print("\n=== Search articles table ===")
db_script = '''
import sys, os
sys.path.insert(0, '/home/admin/Google-Data-Analysis/backend')
os.chdir('/home/admin/Google-Data-Analysis/backend')

from app.database import SessionLocal, engine
from sqlalchemy import text

db = SessionLocal()
try:
    # List tables
    result = db.execute(text("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name"))
    tables = [r[0] for r in result]
    print(f"Tables: {tables}")
    
    # Find article-related tables
    for t in tables:
        if 'article' in t.lower() or 'pub' in t.lower():
            print(f"\\nTable: {t}")
            result = db.execute(text(f"SELECT * FROM {t} ORDER BY rowid DESC LIMIT 5"))
            cols = result.keys()
            print(f"  Columns: {list(cols)}")
            rows = result.fetchall()
            for row in rows:
                d = dict(zip(cols, row))
                # Print key fields
                title = d.get('title', d.get('name', ''))
                slug = d.get('slug', '')
                status = d.get('status', '')
                site = d.get('site_domain', d.get('site_id', ''))
                print(f"  id={d.get('id')} title='{str(title)[:60]}' slug='{slug}' status={status} site={site}")
except Exception as e:
    # Maybe PostgreSQL
    print(f"SQLite failed: {e}")
    try:
        result = db.execute(text("SELECT table_name FROM information_schema.tables WHERE table_schema='public'"))
        tables = [r[0] for r in result]
        print(f"PG Tables: {tables}")
        
        for t in tables:
            if 'article' in t.lower() or 'pub' in t.lower():
                print(f"\\nTable: {t}")
                result = db.execute(text(f'SELECT * FROM "{t}" ORDER BY id DESC LIMIT 5'))
                cols = result.keys()
                print(f"  Columns: {list(cols)}")
                rows = result.fetchall()
                for row in rows:
                    d = dict(zip(cols, row))
                    title = d.get('title', d.get('name', ''))
                    slug = d.get('slug', '')
                    status = d.get('status', '')
                    site = d.get('site_domain', d.get('site_id', ''))
                    print(f"  id={d.get('id')} title=\\'{str(title)[:60]}\\' slug=\\'{slug}\\' status={status} site={site}")
    except Exception as e2:
        print(f"PG also failed: {e2}")
finally:
    db.close()
'''

sftp = ssh.open_sftp()
with sftp.open('/tmp/check_db2.py', 'w') as f:
    f.write(db_script)
sftp.close()

stdin, stdout, stderr = ssh.exec_command(
    'cd /home/admin/Google-Data-Analysis/backend && source venv/bin/activate && python /tmp/check_db2.py 2>&1'
)
stdout.channel.settimeout(20)
try:
    print(stdout.read().decode()[-4000:])
except:
    print("(timeout)")

ssh.close()
