import paramiko
import time
import os
import sys
import io
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

# 1. Upload backend files
print("[1] Uploading backend files...")
backend_files = [
    'backend/app/services/article_gen_service.py',
    'backend/app/services/merchant_crawler.py',
    'backend/app/services/humanizer_service.py',
    'backend/app/api/article_gen.py',
]
for f in backend_files:
    local = os.path.join(LOCAL_BASE, f)
    remote = f'{REMOTE_BASE}/{f}'
    sftp.put(local, remote)
    print(f"  OK: {f}")

# 2. Upload frontend dist
print("\n[2] Uploading frontend dist...")
dist_dir = os.path.join(LOCAL_BASE, 'frontend', 'dist')
remote_dist = f'{REMOTE_BASE}/frontend/dist'

# Clean old assets first
print("  Cleaning old assets...")
ssh.exec_command(f'rm -rf {remote_dist}/assets/*')
time.sleep(1)

uploaded = 0
for root, dirs, files in os.walk(dist_dir):
    rel_root = os.path.relpath(root, dist_dir).replace('\\', '/')
    if rel_root == '.':
        remote_root = remote_dist
    else:
        remote_root = f'{remote_dist}/{rel_root}'
        ssh.exec_command(f'mkdir -p {remote_root}')
        time.sleep(0.2)
    
    for fname in files:
        local_f = os.path.join(root, fname)
        remote_f = f'{remote_root}/{fname}'
        try:
            sftp.put(local_f, remote_f)
            uploaded += 1
        except Exception as e:
            print(f"  WARN: {fname}: {e}")

print(f"  OK: {uploaded} files uploaded")

# 3. Force restart backend
print("\n[3] Restarting backend...")

# Kill all uvicorn
stdin, stdout, stderr = ssh.exec_command("lsof -ti:8000 2>/dev/null")
pids = stdout.read().decode().strip()
if pids:
    pid_list = [p.strip() for p in pids.split('\n') if p.strip().isdigit()]
    if pid_list:
        print(f"  Killing PIDs: {' '.join(pid_list)}")
        ssh.exec_command(f"kill -9 {' '.join(pid_list)}")
        time.sleep(3)

ssh.exec_command("pkill -9 -f 'uvicorn app.main'")
time.sleep(3)

# Verify port is free
stdin, stdout, stderr = ssh.exec_command("ss -tlnp | grep 8000")
check = stdout.read().decode().strip()
if check:
    print(f"  Port still in use, force killing...")
    ssh.exec_command("fuser -k 8000/tcp")
    time.sleep(3)

# Start
start_cmd = (
    f'cd {REMOTE_BASE}/backend && '
    'source venv/bin/activate && '
    'nohup python -m uvicorn app.main:app --host 0.0.0.0 --port 8000 --workers 2 '
    '> /home/admin/backend.log 2>&1 &'
)
transport = ssh.get_transport()
channel = transport.open_session()
channel.exec_command(start_cmd)
time.sleep(8)

# Verify
stdin, stdout, stderr = ssh.exec_command('ps aux | grep uvicorn | grep -v grep | head -3')
result = stdout.read().decode()
if 'uvicorn' in result:
    print("  uvicorn RUNNING")
else:
    print("  uvicorn NOT running! Log:")
    stdin, stdout, stderr = ssh.exec_command('tail -20 /home/admin/backend.log')
    print(stdout.read().decode()[-600:])

# Health check
time.sleep(3)
stdin, stdout, stderr = ssh.exec_command('curl -s -o /dev/null -w "%{http_code}" http://localhost:8000/health')
code = stdout.read().decode().strip()
print(f"  Health: HTTP {code}")

# 4. Verify new code is loaded
print("\n[4] Verifying deployment...")
checks = {
    "article_gen.py stock_images": "grep -c 'stock_images' " + f"{REMOTE_BASE}/backend/app/api/article_gen.py",
    "article_gen_service.py AUTHENTICITY": "grep -c 'AUTHENTICITY FIRST' " + f"{REMOTE_BASE}/backend/app/services/article_gen_service.py",
    "merchant_crawler.py stealth": "grep -c '_build_stealth_headers' " + f"{REMOTE_BASE}/backend/app/services/merchant_crawler.py",
    "frontend dist fresh": f"ls -la {REMOTE_BASE}/frontend/dist/index.html",
}
for label, cmd in checks.items():
    stdin, stdout, stderr = ssh.exec_command(cmd)
    out = stdout.read().decode().strip()
    print(f"  {label}: {out}")

# 5. Check startup log for errors
print("\n[5] Startup log:")
stdin, stdout, stderr = ssh.exec_command('tail -8 /home/admin/backend.log')
print(stdout.read().decode()[-500:])

sftp.close()
ssh.close()
print("\nDONE!")
