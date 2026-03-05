"""OPT-011 部署脚本：git pull + 建表 + 重启后端"""
import paramiko
import time

HOST = '47.239.193.33'
USER = 'admin'
PASS = 'A123456'
PROJECT = '/home/admin/Google-Data-Analysis'


def run_cmd(desc, cmd, timeout=60):
    print(f"\n{'='*50}")
    print(f"[STEP] {desc}")
    print(f"[CMD]  {cmd}")
    ssh = paramiko.SSHClient()
    ssh.set_missing_host_key_policy(paramiko.AutoAddPolicy())
    ssh.connect(HOST, port=22, username=USER, password=PASS, timeout=15)
    stdin, stdout, stderr = ssh.exec_command(cmd, timeout=timeout)
    out = stdout.read().decode()
    err = stderr.read().decode()
    if out.strip():
        print(f"[OUT]  {out.strip()}")
    if err.strip():
        print(f"[ERR]  {err.strip()}")
    ssh.close()
    return out, err


# Step 1: Git pull
run_cmd("Git pull", f"cd {PROJECT} && git pull origin main 2>&1")

# Step 2: Install dependencies
run_cmd("Install deps", f"cd {PROJECT}/backend && source venv/bin/activate && pip install httpx 2>&1 | tail -5")

# Step 3: Create new tables (run a Python script that creates tables)
create_tables_cmd = f"""cd {PROJECT}/backend && source venv/bin/activate && python -c "
from app.database import engine, Base
from app.models.article import *
Base.metadata.create_all(bind=engine)
print('Tables created successfully')
" 2>&1"""
run_cmd("Create pub_* tables", create_tables_cmd)

# Step 4: Kill old backend
run_cmd("Kill old uvicorn", "pkill -f uvicorn 2>&1 || echo 'No uvicorn running'")
time.sleep(3)

# Step 5: Start new backend
start_cmd = f"cd {PROJECT}/backend && source venv/bin/activate && nohup python -m uvicorn app.main:app --host 0.0.0.0 --port 8000 --workers 2 > /home/admin/backend.log 2>&1 & echo STARTED"
run_cmd("Start backend", start_cmd)

# Step 6: Wait and verify
time.sleep(5)
out, _ = run_cmd("Health check", "curl -s http://localhost:8000/health 2>&1")

if '"status":"ok"' in out or '"status": "ok"' in out:
    print("\n" + "=" * 50)
    print("[OK] Backend is running!")
    print("=" * 50)
else:
    print("\n[WARN] Health check did not return ok, checking logs...")
    run_cmd("Check logs", "tail -30 /home/admin/backend.log 2>&1")

# Step 7: Verify new API endpoints exist
out2, _ = run_cmd("Verify articles API", "curl -s -o /dev/null -w '%{http_code}' http://localhost:8000/api/article-categories 2>&1")
print(f"\n[INFO] /api/article-categories status: {out2.strip()}")

print("\n" + "=" * 50)
print("[DONE] OPT-011 deployment complete!")
print("=" * 50)
