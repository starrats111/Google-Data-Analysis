"""Restart backend and verify"""
import paramiko, sys, time
sys.stdout.reconfigure(encoding='utf-8')

ssh = paramiko.SSHClient()
ssh.set_missing_host_key_policy(paramiko.AutoAddPolicy())
ssh.connect('47.239.193.33', username='admin', password='A123456', timeout=30)

def run(cmd, timeout=15):
    print(f">>> {cmd}")
    stdin, stdout, stderr = ssh.exec_command(cmd, timeout=timeout)
    o = stdout.read().decode('utf-8', errors='replace').strip()
    e = stderr.read().decode('utf-8', errors='replace').strip()
    if o: print(o[:1500])
    if e and 'warning' not in e.lower(): print(f'STDERR: {e[:500]}')
    return o

# Check if already running (files were uploaded, pkill was sent)
result = run("ps aux | grep uvicorn | grep -v grep")
if 'uvicorn' not in result:
    print("\nBackend not running, starting...")
    # Use bash -c with & to avoid blocking
    ssh.exec_command("bash -c 'cd /home/admin/Google-Data-Analysis/backend && source venv/bin/activate && nohup python -m uvicorn app.main:app --host 0.0.0.0 --port 8000 --workers 2 >> /home/admin/backend.log 2>&1 &'", timeout=5)
    time.sleep(5)
    result = run("ps aux | grep uvicorn | grep -v grep")

# Verify health
print("\n=== Health check ===")
run("curl -s -o /dev/null -w '%{http_code}' http://localhost:8000/api/health")

# Check recent log
print("\n=== Recent log ===")
run("tail -5 /home/admin/backend.log")

ssh.close()
print("\nDone!")
