"""更新 API Key + 修复 fallback + 重启后端"""
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
        print("[stderr]", err.strip()[-200:])
    return out

# 1. 更新 .env: Claude API Key + Gemini API Key 统一
run("""
cd /home/admin/Google-Data-Analysis/backend
sed -i 's/^CLAUDE_API_KEY=.*/CLAUDE_API_KEY=sk-GnyqfCWVSvemBuu0wobhFBBPEmX8f6lmy7Rki2BuUEqp9yMC/' .env
sed -i 's/^gemini_api_key=.*/gemini_api_key=sk-GnyqfCWVSvemBuu0wobhFBBPEmX8f6lmy7Rki2BuUEqp9yMC/' .env
echo "DONE"
""", "Step 1: Update .env API Keys")

# 2. 验证 .env
run('grep -i "api_key" /home/admin/Google-Data-Analysis/backend/.env', "Step 2: Verify .env")

# 3. 拉取最新代码 (含 fallback 修复)
run('cd /home/admin/Google-Data-Analysis && git pull origin main 2>&1', "Step 3: Git Pull")

# 4. 重启后端
run('pkill -f uvicorn 2>&1; sleep 2; echo STOPPED', "Step 4: Stop Backend")
time.sleep(3)
run('cd /home/admin/Google-Data-Analysis/backend && source venv/bin/activate && nohup python -m uvicorn app.main:app --host 0.0.0.0 --port 8000 --workers 2 > /home/admin/backend.log 2>&1 & echo STARTED', "Step 5: Start Backend")
time.sleep(6)

# 5. 验证
result = run('ps aux | grep uvicorn | grep -v grep', "Step 6: Verify")
health = run('curl -s -o /dev/null -w "%{http_code}" http://localhost:8000/health')
print(f"Health: {health.strip()}")

ssh.close()
print("\nDone!")
