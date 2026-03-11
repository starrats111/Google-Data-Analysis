import paramiko, sys
sys.stdout.reconfigure(encoding='utf-8')

ssh = paramiko.SSHClient()
ssh.set_missing_host_key_policy(paramiko.AutoAddPolicy())
ssh.connect("47.239.193.33", username="admin", password="A123456", timeout=10)

sftp = ssh.open_sftp()
with sftp.open("/tmp/check_mainjs.py", "w") as f:
    f.write('''
import sys, os
sys.path.insert(0, "/home/admin/Google-Data-Analysis/backend")
os.chdir("/home/admin/Google-Data-Analysis/backend")

from app.services.remote_publisher import RemotePublisher

pub = RemotePublisher()
ssh_client = pub._connect()
sftp = ssh_client.open_sftp()

SITE_ROOT = "/www/wwwroot/zontri.top"

# 1. Read main.js - article lookup logic
print("=== main.js (article lookup) ===")
try:
    with sftp.open(f"{SITE_ROOT}/js/main.js", "r") as f:
        mainjs = f.read().decode("utf-8", errors="replace")
    print(f"Size: {len(mainjs)} bytes")
    # Find article-related logic
    lines = mainjs.split("\\n")
    for i, line in enumerate(lines):
        low = line.lower()
        if any(kw in low for kw in ["slug", "title", "urlsearchparams", "articlesindex", "article", "find", "filter"]):
            start = max(0, i-2)
            end = min(len(lines), i+3)
            ctx = "\\n".join(lines[start:end])
            print(f"\\n[Line {i+1}]\\n{ctx}")
except Exception as e:
    print(f"Error: {e}")

# 2. Read articles-index.js full content  
print("\\n\\n=== articles-index.js (full) ===")
try:
    with sftp.open(f"{SITE_ROOT}/js/articles-index.js", "r") as f:
        indexjs = f.read().decode("utf-8", errors="replace")
    print(indexjs[:3000])
except Exception as e:
    print(f"Error: {e}")

# 3. Read 1.json
print("\\n\\n=== 1.json ===")
try:
    with sftp.open(f"{SITE_ROOT}/js/articles/1.json", "r") as f:
        content = f.read().decode("utf-8", errors="replace")
    print(f"Size: {len(content)} bytes")
    import json
    data = json.loads(content)
    print(f"id: {data.get('id')}")
    print(f"slug: {data.get('slug')}")
    print(f"title: {data.get('title')}")
    print(f"author: {data.get('author')}")
    print(f"content length: {len(data.get('content', ''))}")
except Exception as e:
    print(f"Error: {e}")

sftp.close()
ssh_client.close()
''')
sftp.close()

stdin, stdout, stderr = ssh.exec_command(
    "cd /home/admin/Google-Data-Analysis/backend && source venv/bin/activate && python3 /tmp/check_mainjs.py 2>&1",
    timeout=30
)
print(stdout.read().decode('utf-8', errors='replace'), flush=True)

ssh.close()
