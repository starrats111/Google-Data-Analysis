"""Restart backend with proper nohup handling"""
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
    if o: print(o[:2000])
    if e and 'warning' not in e.lower(): print(f'STDERR: {e[:500]}')
    return o

# Kill existing
run("pkill -f 'uvicorn app.main' || true")
time.sleep(2)

# Start with nohup via bash -c to avoid blocking
transport = ssh.get_transport()
channel = transport.open_session()
channel.exec_command(
    "cd /home/admin/Google-Data-Analysis/backend && "
    "source venv/bin/activate && "
    "nohup python -m uvicorn app.main:app --host 0.0.0.0 --port 8000 --workers 2 "
    ">> /home/admin/backend.log 2>&1 &"
)
print("Start command sent")
time.sleep(5)

# Verify
out = run("ps aux | grep uvicorn | grep -v grep")
if "uvicorn" in out:
    print("\n✓ Backend is running!")
else:
    print("\n✗ Backend may not have started, checking logs...")
    run("tail -20 /home/admin/backend.log")

run("curl -s -o /dev/null -w '%{http_code}' http://localhost:8000/api/health 2>/dev/null || echo 'checking...'")

ssh.close()
print("\nDone!")
