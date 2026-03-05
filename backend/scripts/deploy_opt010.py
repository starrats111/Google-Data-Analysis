"""OPT-010 部署脚本 — 拉取代码、更新依赖、重启后端"""
import paramiko
import time

ssh = paramiko.SSHClient()
ssh.set_missing_host_key_policy(paramiko.AutoAddPolicy())
ssh.connect('47.239.193.33', port=22, username='admin', password='A123456', timeout=15)

def run(cmd, label=""):
    if label:
        print(f"\n=== {label} ===")
    stdin, stdout, stderr = ssh.exec_command(cmd)
    out = stdout.read().decode()
    err = stderr.read().decode()
    if out.strip():
        print(out.strip())
    if err.strip():
        print("[stderr]", err.strip())
    return out

# 1. 拉取代码
run("cd /home/admin/Google-Data-Analysis && git pull origin main 2>&1", "Step 1: Git Pull")

# 2. 更新 anthropic 依赖
run("cd /home/admin/Google-Data-Analysis/backend && source venv/bin/activate && pip install 'anthropic>=0.25.0' 2>&1 | tail -5", "Step 2: Update Dependencies")

# 3. 停掉旧进程
run("pkill -f uvicorn 2>&1; sleep 2; echo STOPPED", "Step 3: Stop Old Backend")
time.sleep(3)

# 4. 启动新进程
run("cd /home/admin/Google-Data-Analysis/backend && source venv/bin/activate && nohup python -m uvicorn app.main:app --host 0.0.0.0 --port 8000 --workers 2 > /home/admin/backend.log 2>&1 & echo STARTED", "Step 4: Start New Backend")
time.sleep(6)

# 5. 验证
result = run("ps aux | grep uvicorn | grep -v grep", "Step 5: Verify Processes")
health = run('curl -s -o /dev/null -w "%{http_code}" http://localhost:8000/health')
print(f"Health check status: {health.strip()}")

if "uvicorn" in result and "200" in health:
    print("\n✅ OPT-010 部署成功！")
else:
    print("\n⚠️ 部署可能有问题，请检查日志")
    log = run("tail -20 /home/admin/backend.log", "Recent Logs")

ssh.close()
