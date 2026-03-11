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
from app.models.article import PubArticle
from app.models.site import PubSite
db = SessionLocal()
arts = db.query(PubArticle).order_by(PubArticle.id.desc()).limit(5).all()
for a in arts:
    site_domain = ''
    if a.site_id:
        site = db.query(PubSite).filter(PubSite.id == a.site_id).first()
        if site:
            site_domain = site.domain
    print(f'id={{a.id}} status={{a.status}} slug={{a.slug[:60]}}')
    print(f'  title={{a.title[:60]}}')
    print(f'  site_id={{a.site_id}} site_domain={{site_domain}}')
    print(f'  published_to_site={{a.published_to_site}}')
    print(f'  site_article_slug={{a.site_article_slug}}')
    print()
db.close()
" 2>&1""")
print(out, flush=True)

# 2. Check zontri site config
print("=== Zontri site config ===", flush=True)
out, _ = run(f"""cd {PROJECT}/backend && source venv/bin/activate && python3 -c "
from app.database import SessionLocal
from app.models.site import PubSite
db = SessionLocal()
sites = db.query(PubSite).filter(PubSite.domain.like('%zontri%')).all()
for s in sites:
    print(f'id={{s.id}} domain={{s.domain}} site_type={{s.site_type}}')
    print(f'  site_path={{s.site_path}}')
    print(f'  data_js_path={{s.data_js_path}}')
    print(f'  article_var_name={{s.article_var_name}}')
    print(f'  article_html_pattern={{s.article_html_pattern}}')
    print(f'  article_template={{s.article_template}}')
db.close()
" 2>&1""")
print(out, flush=True)

# 3. Check remote files via the publisher's SSH
print("=== Remote files on Baota ===", flush=True)
out, _ = run(f"""cd {PROJECT}/backend && source venv/bin/activate && python3 << 'PYEOF'
from app.services.remote_publisher import RemotePublisher
from app.database import SessionLocal
from app.models.site import PubSite

db = SessionLocal()
site = db.query(PubSite).filter(PubSite.domain.like('%zontri%')).first()
if not site:
    print('No zontri site found')
    exit()

print(f'Site: {{site.domain}} path={{site.site_path}} type={{site.site_type}}')

pub = RemotePublisher()
ssh_client = pub._get_ssh()
sftp = ssh_client.open_sftp()

import stat
# List root
try:
    items = sftp.listdir_attr(site.site_path)
    print(f'Root dir ({{len(items)}} items):')
    for item in items:
        t = 'd' if stat.S_ISDIR(item.st_mode) else '-'
        print(f'  {{t}} {{item.filename}} ({{item.st_size}})')
except Exception as e:
    print(f'Error: {{e}}')

# Check data JS file
data_js = site.data_js_path or 'assets/js/main.js'
full_js = f'{{site.site_path}}/{{data_js}}'
print(f'\\nData JS path: {{full_js}}')
try:
    with sftp.open(full_js, 'r') as f:
        content = f.read().decode('utf-8', errors='replace')
    print(f'  Size: {{len(content)}} bytes')
    print(f'  First 300 chars: {{content[:300]}}')
    if 'holy-grail' in content.lower():
        print('  FOUND: holy-grail slug in JS!')
        idx = content.lower().index('holy-grail')
        print(f'  Context: ...{{content[max(0,idx-50):idx+100]}}...')
    else:
        print('  NOT FOUND: holy-grail slug not in JS file')
    # Count posts
    import re
    slugs = re.findall(r'"slug"\s*:\s*"([^"]+)"', content)
    print(f'  Slugs found: {{len(slugs)}}')
    for s in slugs[:5]:
        print(f'    {{s}}')
except Exception as e:
    print(f'  Error: {{e}}')

# Check for HTML article files
for subdir in ['posts', 'articles', 'post', '.']:
    path = f'{{site.site_path}}/{{subdir}}'
    try:
        items = sftp.listdir(path)
        html_files = [i for i in items if i.endswith('.html') and 'post-' in i.lower()]
        if html_files:
            print(f'\\n{{subdir}}/: {{len(html_files)}} article HTML files')
            for h in html_files[:5]:
                print(f'  {{h}}')
    except:
        pass

sftp.close()
ssh_client.close()
db.close()
PYEOF
""", timeout=30)
print(out, flush=True)

# 4. Check backend logs
print("=== Recent logs ===", flush=True)
out, _ = run("tail -100 /home/admin/backend.log 2>/dev/null | grep -i 'publish\\|zontri\\|error\\|failed\\|article'")
print(out[-2000:] if out.strip() else "(no matching logs)", flush=True)

ssh.close()
