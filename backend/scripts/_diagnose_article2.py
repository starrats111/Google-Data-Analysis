import paramiko, sys
sys.stdout.reconfigure(encoding='utf-8')

ssh = paramiko.SSHClient()
ssh.set_missing_host_key_policy(paramiko.AutoAddPolicy())
ssh.connect("47.239.193.33", username="admin", password="A123456", timeout=10)

def run(cmd, timeout=30):
    stdin, stdout, stderr = ssh.exec_command(cmd, timeout=timeout)
    return stdout.read().decode('utf-8', errors='replace'), stderr.read().decode('utf-8', errors='replace')

PROJECT = "/home/admin/Google-Data-Analysis"

# 1. Check article in DB
print("=== Article in DB ===", flush=True)
out, _ = run(f"""cd {PROJECT}/backend && source venv/bin/activate && python3 -c "
from app.database import SessionLocal
from app.models.article import Article
db = SessionLocal()
arts = db.query(Article).order_by(Article.id.desc()).limit(5).all()
for a in arts:
    print(f'id={{a.id}} status={{a.status}} site={{a.publish_site}} slug={{a.slug}}')
    print(f'  url={{a.publish_url}}')
    print(f'  title={{a.title[:60]}}')
db.close()
" 2>&1""")
print(out, flush=True)

# 2. Check pub_sites config for zontri
print("=== Zontri site config ===", flush=True)
out, _ = run(f"""cd {PROJECT}/backend && source venv/bin/activate && python3 -c "
from app.database import SessionLocal
from app.models.pub_site import PubSite
db = SessionLocal()
sites = db.query(PubSite).filter(PubSite.domain.like('%zontri%')).all()
for s in sites:
    print(f'id={{s.id}} domain={{s.domain}} site_type={{s.site_type}}')
    print(f'  site_path={{s.site_path}}')
    print(f'  data_js_path={{s.data_js_path}}')
    print(f'  article_var_name={{s.article_var_name}}')
    print(f'  article_dir={{getattr(s, \"article_dir\", \"N/A\")}}')
db.close()
" 2>&1""")
print(out, flush=True)

# 3. Check zontri site files via SSH to Baota
print("=== Zontri files on Baota ===", flush=True)
out, _ = run(f"""cd {PROJECT}/backend && source venv/bin/activate && python3 -c "
from app.services.remote_publisher import RemotePublisher
from app.database import SessionLocal
from app.models.pub_site import PubSite
db = SessionLocal()
site = db.query(PubSite).filter(PubSite.domain.like('%zontri%')).first()
if not site:
    print('No zontri site found')
else:
    pub = RemotePublisher()
    ssh_client = pub._get_ssh()
    sftp = ssh_client.open_sftp()
    
    # List site root
    import stat
    site_path = site.site_path or f'/www/wwwroot/{site.domain}'
    print(f'Site path: {{site_path}}')
    try:
        items = sftp.listdir_attr(site_path)
        for item in items[:20]:
            t = 'd' if stat.S_ISDIR(item.st_mode) else '-'
            print(f'  {{t}} {{item.filename}} ({{item.st_size}})')
    except Exception as e:
        print(f'Error listing: {{e}}')
    
    # Check for article HTML files
    try:
        for subdir in ['posts', 'articles', 'post']:
            try:
                posts = sftp.listdir(f'{{site_path}}/{{subdir}}')
                print(f'\\n{{subdir}}/ directory: {{len(posts)}} files')
                for p in posts[:5]:
                    print(f'  {{p}}')
            except:
                pass
    except:
        pass
    
    # Check data JS file
    data_js = site.data_js_path or 'assets/js/main.js'
    full_js = f'{{site_path}}/{{data_js}}'
    print(f'\\nData JS: {{full_js}}')
    try:
        with sftp.open(full_js, 'r') as f:
            content = f.read(500).decode('utf-8', errors='replace')
            print(f'  Content preview: {{content[:300]}}')
            f.seek(0)
            full_content = f.read().decode('utf-8', errors='replace')
            if 'holy-grail' in full_content.lower() or 'fira' in full_content.lower():
                print('  FOUND: Article slug in JS file!')
            else:
                print('  NOT FOUND: Article slug not in JS file')
            print(f'  Total size: {{len(full_content)}} bytes')
    except Exception as e:
        print(f'  Error reading JS: {{e}}')
    
    sftp.close()
    ssh_client.close()
db.close()
" 2>&1""", timeout=30)
print(out, flush=True)

# 4. Check backend publish logs
print("=== Recent publish logs ===", flush=True)
out, _ = run("grep -i 'publish\\|zontri\\|holy.grail\\|article.*发布' /home/admin/backend.log 2>/dev/null | tail -30")
print(out if out.strip() else "(no publish logs found)", flush=True)

ssh.close()
