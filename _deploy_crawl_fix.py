import paramiko
import time
import os
import sys, io
sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding='utf-8', errors='replace')

SERVER = '47.239.193.33'
USER = 'admin'
PASS = 'A123456'
REMOTE_BASE = '/home/admin/Google-Data-Analysis'
LOCAL_BASE = r'd:\Google Analysis'

ssh = paramiko.SSHClient()
ssh.set_missing_host_key_policy(paramiko.AutoAddPolicy())
ssh.connect(SERVER, port=22, username=USER, password=PASS, timeout=15)
sftp = ssh.open_sftp()

# Upload updated files
print("[1] Uploading updated files...")
files = [
    'backend/app/services/merchant_crawler.py',
    'backend/app/api/article_gen.py',
]
for f in files:
    sftp.put(os.path.join(LOCAL_BASE, f), f'{REMOTE_BASE}/{f}')
    print(f"  OK: {f}")

# Restart
print("\n[2] Restarting backend...")
stdin, stdout, stderr = ssh.exec_command("lsof -ti:8000 2>/dev/null")
pids = [p.strip() for p in stdout.read().decode().strip().split('\n') if p.strip().isdigit()]
if pids:
    ssh.exec_command(f"kill -9 {' '.join(pids)}")
    time.sleep(3)
ssh.exec_command("pkill -9 -f 'uvicorn app.main'")
time.sleep(3)

transport = ssh.get_transport()
channel = transport.open_session()
channel.exec_command(
    f'cd {REMOTE_BASE}/backend && source venv/bin/activate && '
    'nohup python -m uvicorn app.main:app --host 0.0.0.0 --port 8000 --workers 2 '
    '> /home/admin/backend.log 2>&1 &'
)
time.sleep(8)

stdin, stdout, stderr = ssh.exec_command('curl -s -o /dev/null -w "%{http_code}" http://localhost:8000/health')
code = stdout.read().decode().strip()
print(f"  Health: HTTP {code}")

# Test crawl
print("\n[3] Testing 1stphorm.com crawl with new code...")
test_script = '''
import sys, os
sys.path.insert(0, '/home/admin/Google-Data-Analysis/backend')
os.chdir('/home/admin/Google-Data-Analysis/backend')
from app.services.merchant_crawler import crawl
result = crawl("https://1stphorm.com/")
print(f"crawl_failed: {result.get('crawl_failed')}")
print(f"brand: {result.get('brand_name', '')}")
pages = result.get('pages', [])
total_imgs = sum(len(p.get('images', [])) for p in pages)
print(f"pages: {len(pages)}, images: {total_imgs}")
if total_imgs > 0:
    for p in pages:
        for img in p.get('images', [])[:3]:
            print(f"  img: {img[:100]}")
if result.get('error'):
    print(f"error: {result['error']}")
'''
with sftp.open('/tmp/test_crawl_final.py', 'w') as f:
    f.write(test_script)

stdin, stdout, stderr = ssh.exec_command(
    f'cd {REMOTE_BASE}/backend && source venv/bin/activate && timeout 45 python /tmp/test_crawl_final.py 2>&1'
)
stdout.channel.settimeout(50)
try:
    print(stdout.read().decode()[-2000:])
except:
    print("(timeout)")

sftp.close()
ssh.close()
print("\nDone!")
