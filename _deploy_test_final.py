import paramiko
import time
import os
import sys, io
sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding='utf-8', errors='replace')

ssh = paramiko.SSHClient()
ssh.set_missing_host_key_policy(paramiko.AutoAddPolicy())
ssh.connect('47.239.193.33', port=22, username='admin', password='A123456', timeout=15)
sftp = ssh.open_sftp()

# Upload
print("[1] Upload merchant_crawler.py...")
sftp.put(r'd:\Google Analysis\backend\app\services\merchant_crawler.py',
         '/home/admin/Google-Data-Analysis/backend/app/services/merchant_crawler.py')
print("  OK")

# Restart
print("[2] Restart...")
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
    'cd /home/admin/Google-Data-Analysis/backend && source venv/bin/activate && '
    'nohup python -m uvicorn app.main:app --host 0.0.0.0 --port 8000 --workers 2 '
    '> /home/admin/backend.log 2>&1 &'
)
time.sleep(8)
stdin, stdout, stderr = ssh.exec_command('curl -s -o /dev/null -w "%{http_code}" http://localhost:8000/health')
print(f"  Health: HTTP {stdout.read().decode().strip()}")

# Test
print("\n[3] Test 1stphorm.com crawl...")
test_script = '''
import sys, os
sys.path.insert(0, '/home/admin/Google-Data-Analysis/backend')
os.chdir('/home/admin/Google-Data-Analysis/backend')
from app.services.merchant_crawler import crawl
result = crawl("https://1stphorm.com/")
print(f"crawl_failed: {result.get('crawl_failed')}")
print(f"brand: '{result.get('brand_name', '')}'")
pages = result.get('pages', [])
total_imgs = sum(len(p.get('images', [])) for p in pages)
print(f"pages: {len(pages)}, total images: {total_imgs}")
if pages:
    print(f"title: '{pages[0].get('title', '')}'")
    print(f"text length: {len(pages[0].get('text', ''))}")
    for img in pages[0].get('images', [])[:5]:
        print(f"  img: {img[:120]}")
if result.get('error'):
    print(f"error: {result['error']}")
'''
with sftp.open('/tmp/test_final.py', 'w') as f:
    f.write(test_script)

stdin, stdout, stderr = ssh.exec_command(
    'cd /home/admin/Google-Data-Analysis/backend && source venv/bin/activate && timeout 60 python /tmp/test_final.py 2>&1'
)
stdout.channel.settimeout(65)
try:
    out = stdout.read().decode()
    print(out[-2000:])
except:
    print("(timeout)")

sftp.close()
ssh.close()
print("\nDone!")
