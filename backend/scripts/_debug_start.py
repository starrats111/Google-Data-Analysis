import paramiko, time, sys
sys.stdout.reconfigure(encoding='utf-8')
ssh = paramiko.SSHClient()
ssh.set_missing_host_key_policy(paramiko.AutoAddPolicy())
ssh.connect('47.239.193.33', username='admin', password='A123456', timeout=30)

def run(cmd, timeout=15):
    _, stdout, stderr = ssh.exec_command(cmd, timeout=timeout)
    o = stdout.read().decode('utf-8', errors='replace').strip()
    e = stderr.read().decode('utf-8', errors='replace').strip()
    if o: print(o[:3000])
    if e: print(f'ERR: {e[:500]}')
    return o

# Check if port 8000 is in use
print("=== Port check ===")
run("ss -tlnp | grep 8000")
run("lsof -i :8000 2>/dev/null || true")

# Try starting and capture error
print("\n=== Try start ===")
run("cd /home/admin/Google-Data-Analysis/backend && source venv/bin/activate && python -m uvicorn app.main:app --host 0.0.0.0 --port 8000 --workers 1 2>&1 | head -30", timeout=12)

ssh.close()
