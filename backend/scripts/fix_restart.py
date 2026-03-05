import paramiko
import time

HOST = '47.239.193.33'
USER = 'admin'
PASS = 'A123456'

def run(desc, cmd, timeout=30):
    print(f"\n[{desc}]")
    ssh = paramiko.SSHClient()
    ssh.set_missing_host_key_policy(paramiko.AutoAddPolicy())
    ssh.connect(HOST, port=22, username=USER, password=PASS, timeout=15)
    stdin, stdout, stderr = ssh.exec_command(cmd, timeout=timeout)
    out = stdout.read().decode().strip()
    err = stderr.read().decode().strip()
    if out: print(out)
    if err: print(f"ERR: {err}")
    ssh.close()
    return out

# 1. Kill all uvicorn processes
run("Kill all uvicorn", "pkill -9 -f uvicorn; sleep 2; ps aux | grep uvicorn | grep -v grep || echo 'All killed'")

# 2. Git pull latest
run("Git pull", "cd /home/admin/Google-Data-Analysis && git pull origin main")

# 3. Check port is free
run("Check port 8000", "ss -tlnp | grep 8000 || echo 'Port 8000 is free'")

# 4. Start backend
run("Start backend", 
    "cd /home/admin/Google-Data-Analysis/backend && "
    "nohup /home/admin/Google-Data-Analysis/backend/venv/bin/python3 "
    "-m uvicorn app.main:app --host 0.0.0.0 --port 8000 --workers 1 "
    "> /home/admin/Google-Data-Analysis/backend/backend.log 2>&1 &"
    " && echo 'Started'"
)

# 5. Wait for startup
print("\n[Waiting 8s for startup...]")
time.sleep(8)

# 6. Health check
run("Health check", "curl -s -m 10 http://localhost:8000/health")

# 7. Verify process
run("Verify process", "ps aux | grep uvicorn | grep -v grep")

# 8. Check recent log
run("Recent log", "tail -20 /home/admin/Google-Data-Analysis/backend/backend.log")
