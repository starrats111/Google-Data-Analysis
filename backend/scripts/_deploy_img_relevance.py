"""Deploy image relevance fix and restart backend"""
import paramiko, time, sys, os
sys.stdout.reconfigure(encoding='utf-8')

BE_HOST = '47.239.193.33'
BE_USER = 'admin'
BE_PASS = 'A123456'
BE_DIR = '/home/admin/Google-Data-Analysis/backend'

ssh = paramiko.SSHClient()
ssh.set_missing_host_key_policy(paramiko.AutoAddPolicy())
ssh.connect(BE_HOST, username=BE_USER, password=BE_PASS, timeout=30)
print("Connected")

# Upload files
sftp = ssh.open_sftp()
base = r'd:\Google Analysis'
files = [
    ('backend/app/api/article_gen.py', f'{BE_DIR}/app/api/article_gen.py'),
    ('backend/app/services/merchant_crawler.py', f'{BE_DIR}/app/services/merchant_crawler.py'),
]
for local_rel, remote in files:
    local = os.path.join(base, local_rel)
    if os.path.exists(local):
        sftp.put(local, remote)
        print(f"✓ {local_rel}")
    else:
        print(f"✗ NOT FOUND: {local}")
sftp.close()

# Force restart
def run(cmd, timeout=15):
    _, stdout, stderr = ssh.exec_command(cmd, timeout=timeout)
    o = stdout.read().decode('utf-8', errors='replace').strip()
    e = stderr.read().decode('utf-8', errors='replace').strip()
    if o: print(o[:2000])
    if e and 'warning' not in e.lower(): print(f'ERR: {e[:500]}')
    return o

run("pkill -9 -f uvicorn || true")
time.sleep(2)

transport = ssh.get_transport()
ch = transport.open_session()
ch.exec_command(
    f"cd {BE_DIR} && source venv/bin/activate && "
    "nohup python -m uvicorn app.main:app --host 0.0.0.0 --port 8000 --workers 2 "
    ">> /home/admin/backend.log 2>&1 &"
)
print("Start command sent")
time.sleep(6)

out = run("ps aux | grep uvicorn | grep -v grep")
if "uvicorn" in out:
    print("\n✓ Backend running!")
else:
    print("\n✗ Not started, checking logs...")
    run("tail -20 /home/admin/backend.log")

# Verify our changes are deployed
print("\n=== Verify deployed code ===")
run(f"grep -c 'min_width=300' {BE_DIR}/app/api/article_gen.py")
run(f"grep -c 'crawled_count == 0' {BE_DIR}/app/api/article_gen.py")
run(f"grep -c 'testimonial' {BE_DIR}/app/services/merchant_crawler.py")

ssh.close()
print("\nDeploy complete!")
