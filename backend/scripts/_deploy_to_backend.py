"""Deploy changes to backend server via SFTP"""
import paramiko, sys, os, time
sys.stdout.reconfigure(encoding='utf-8')

BE_HOST = '47.239.193.33'
BE_USER = 'admin'
BE_PASS = 'A123456'
BE_DIR = '/home/admin/Google-Data-Analysis/backend'

ssh = paramiko.SSHClient()
ssh.set_missing_host_key_policy(paramiko.AutoAddPolicy())
ssh.connect(BE_HOST, username=BE_USER, password=BE_PASS, timeout=30)
print("SSH connected to backend")

def run(cmd, timeout=30):
    print(f">>> {cmd}")
    stdin, stdout, stderr = ssh.exec_command(cmd, timeout=timeout)
    o = stdout.read().decode('utf-8', errors='replace').strip()
    e = stderr.read().decode('utf-8', errors='replace').strip()
    if o: print(o[:2000])
    if e and 'warning' not in e.lower(): print(f'STDERR: {e[:500]}')
    return o

# Files to deploy
files_to_deploy = [
    ('backend/app/api/article_gen.py', f'{BE_DIR}/app/api/article_gen.py'),
    ('backend/app/services/article_gen_service.py', f'{BE_DIR}/app/services/article_gen_service.py'),
    ('backend/app/services/remote_publisher.py', f'{BE_DIR}/app/services/remote_publisher.py'),
    ('backend/app/services/merchant_crawler.py', f'{BE_DIR}/app/services/merchant_crawler.py'),
]

# Upload files via SFTP
sftp = ssh.open_sftp()
base_dir = r'd:\Google Analysis'

for local_rel, remote_path in files_to_deploy:
    local_path = os.path.join(base_dir, local_rel)
    if os.path.exists(local_path):
        print(f"Uploading {local_rel} -> {remote_path}")
        sftp.put(local_path, remote_path)
        print(f"  OK")
    else:
        print(f"SKIP (not found): {local_path}")

sftp.close()
print("\nAll files uploaded")

# Restart backend
print("\n=== Restarting backend ===")
run("pkill -f 'uvicorn app.main' || true")
time.sleep(2)
run("cd /home/admin/Google-Data-Analysis/backend && source venv/bin/activate && nohup python -m uvicorn app.main:app --host 0.0.0.0 --port 8000 --workers 2 >> /home/admin/backend.log 2>&1 & disown && echo 'Started'")
time.sleep(3)

# Verify
print("\n=== Verifying backend ===")
run("ps aux | grep uvicorn | grep -v grep")
run("curl -s http://localhost:8000/api/health 2>/dev/null || curl -s http://localhost:8000/health 2>/dev/null || echo 'Checking port...'")
run("curl -s -o /dev/null -w '%{http_code}' http://localhost:8000/api/health 2>/dev/null || echo 'N/A'")

ssh.close()
print("\nDeploy complete!")
