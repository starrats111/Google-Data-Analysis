"""Force kill all uvicorn and restart fresh, then test crawl"""
import paramiko, time, sys
sys.stdout.reconfigure(encoding='utf-8')

BE_HOST = '47.239.193.33'
BE_USER = 'admin'
BE_PASS = 'A123456'

ssh = paramiko.SSHClient()
ssh.set_missing_host_key_policy(paramiko.AutoAddPolicy())
ssh.connect(BE_HOST, username=BE_USER, password=BE_PASS, timeout=30)
print("Connected")

def run(cmd, timeout=15):
    print(f">>> {cmd}")
    _, stdout, stderr = ssh.exec_command(cmd, timeout=timeout)
    o = stdout.read().decode('utf-8', errors='replace').strip()
    e = stderr.read().decode('utf-8', errors='replace').strip()
    if o: print(o[:3000])
    if e and 'warning' not in e.lower(): print(f'STDERR: {e[:500]}')
    return o

# Force kill ALL uvicorn processes
run("pkill -9 -f uvicorn || true")
time.sleep(2)
run("ps aux | grep uvicorn | grep -v grep")
print("All uvicorn killed")

# Verify the deployed code has our changes
print("\n=== Checking deployed code ===")
run("grep -c '图片相关性过滤' /home/admin/Google-Data-Analysis/backend/app/api/article_gen.py")
run("grep -c 'testimonial' /home/admin/Google-Data-Analysis/backend/app/services/merchant_crawler.py")

# Start fresh
print("\n=== Starting fresh ===")
transport = ssh.get_transport()
channel = transport.open_session()
channel.exec_command(
    "cd /home/admin/Google-Data-Analysis/backend && "
    "source venv/bin/activate && "
    "nohup python -m uvicorn app.main:app --host 0.0.0.0 --port 8000 --workers 2 "
    ">> /home/admin/backend.log 2>&1 &"
)
print("Start command sent")
time.sleep(6)

# Verify running
out = run("ps aux | grep uvicorn | grep -v grep")
if "uvicorn" in out:
    print("\n✓ Backend restarted!")
else:
    print("\n✗ Failed to start")
    run("tail -30 /home/admin/backend.log")

ssh.close()
