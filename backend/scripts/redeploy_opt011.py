"""OPT-011 热修复部署：git pull + 重启后端"""
import paramiko, time

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

# Step 1: Pull fix
run("Git pull", "cd /home/admin/Google-Data-Analysis && git pull origin main 2>&1")

# Step 2: Kill
run("Kill uvicorn", "pkill -f uvicorn 2>&1 || echo no process")
time.sleep(3)

# Step 3: Start (fire and forget)
ssh = paramiko.SSHClient()
ssh.set_missing_host_key_policy(paramiko.AutoAddPolicy())
ssh.connect(HOST, port=22, username=USER, password=PASS, timeout=15)
ssh.exec_command("cd /home/admin/Google-Data-Analysis/backend && source venv/bin/activate && nohup python -m uvicorn app.main:app --host 0.0.0.0 --port 8000 --workers 2 > /home/admin/backend.log 2>&1 &")
ssh.close()
print("\n[Start backend] Command sent, waiting 8s...")
time.sleep(8)

# Step 4: Verify
out = run("Health check", "curl -s http://localhost:8000/health 2>&1")
if '"ok"' in out:
    print("\n[OK] Backend is healthy!")
else:
    print("\n[WARN] Checking logs...")
    run("Logs", "tail -20 /home/admin/backend.log 2>&1")

run("Articles API", "curl -s -o /dev/null -w '%{http_code}' http://localhost:8000/api/article-categories 2>&1")
print("\nDone!")
