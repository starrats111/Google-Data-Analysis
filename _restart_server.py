import paramiko
import time

ssh = paramiko.SSHClient()
ssh.set_missing_host_key_policy(paramiko.AutoAddPolicy())
ssh.connect('47.239.193.33', port=22, username='admin', password='A123456', timeout=15)

# 1. Kill all uvicorn
print("Killing uvicorn...")
stdin, stdout, stderr = ssh.exec_command("ps aux | grep uvicorn | grep -v grep | awk '{print $2}'")
pids = stdout.read().decode().strip().split('\n')
pids = [p.strip() for p in pids if p.strip()]
if pids:
    pid_str = ' '.join(pids)
    print(f"  Killing PIDs: {pid_str}")
    ssh.exec_command(f'kill -9 {pid_str}')
    time.sleep(3)
else:
    print("  No uvicorn processes found")

# 2. Check backend log for errors
print("\nChecking last backend log...")
stdin, stdout, stderr = ssh.exec_command('tail -20 /home/admin/backend.log')
log = stdout.read().decode()
print(log[-500:] if log else "(empty)")

# 3. Start uvicorn via transport channel (non-blocking)
print("\nStarting uvicorn...")
start_cmd = (
    'cd /home/admin/Google-Data-Analysis/backend && '
    'source venv/bin/activate && '
    'nohup python -m uvicorn app.main:app --host 0.0.0.0 --port 8000 --workers 2 '
    '> /home/admin/backend.log 2>&1 &'
)
transport = ssh.get_transport()
channel = transport.open_session()
channel.exec_command(start_cmd)
print("  Command sent, waiting 8 seconds...")
time.sleep(8)

# 4. Verify
print("\nVerifying...")
stdin, stdout, stderr = ssh.exec_command('ps aux | grep uvicorn | grep -v grep | head -5')
result = stdout.read().decode()
if 'uvicorn' in result:
    print("  uvicorn is RUNNING")
    lines = result.strip().split('\n')
    for l in lines:
        print(f"    {l.strip()[:100]}")
else:
    print("  uvicorn NOT running! Checking log...")
    stdin, stdout, stderr = ssh.exec_command('tail -30 /home/admin/backend.log')
    print(stdout.read().decode()[-800:])

# 5. Health check
time.sleep(3)
stdin, stdout, stderr = ssh.exec_command('curl -s -o /dev/null -w "%{http_code}" http://localhost:8000/health')
code = stdout.read().decode().strip()
print(f"\nHealth check: HTTP {code}")

ssh.close()
print("\nDone!")
