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

# 1. Start backend (nohup with & only)
run("Start backend",
    "cd /home/admin/Google-Data-Analysis/backend; "
    "nohup /home/admin/Google-Data-Analysis/backend/venv/bin/python3 "
    "-m uvicorn app.main:app --host 0.0.0.0 --port 8000 --workers 1 "
    "> /home/admin/Google-Data-Analysis/backend/backend.log 2>&1 &"
)

# 2. Wait for startup
print("\n[Waiting 10s for startup...]")
time.sleep(10)

# 3. Health check
result = run("Health check", "curl -s -m 10 http://localhost:8000/health")

# 4. Verify process
run("Verify process", "ps aux | grep uvicorn | grep -v grep")

# 5. Check log
run("Recent log", "tail -30 /home/admin/Google-Data-Analysis/backend/backend.log")

if result:
    print("\n=== Backend started successfully ===")
else:
    print("\n=== WARNING: Health check failed, checking log for errors ===")
