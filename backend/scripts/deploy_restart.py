import paramiko
import time

HOST = '47.239.193.33'
USER = 'admin'
PASS = 'A123456'

def run(desc, cmd, timeout=30, retries=3):
    print(f"\n{'='*60}")
    print(f"[{desc}]")
    print(f"{'='*60}")
    for attempt in range(retries):
        try:
            ssh = paramiko.SSHClient()
            ssh.set_missing_host_key_policy(paramiko.AutoAddPolicy())
            ssh.connect(HOST, port=22, username=USER, password=PASS, timeout=15,
                        banner_timeout=30, auth_timeout=30)
            stdin, stdout, stderr = ssh.exec_command(cmd, timeout=timeout)
            out = stdout.read().decode().strip()
            err = stderr.read().decode().strip()
            if out: print(out)
            if err: print(f"STDERR: {err}")
            if not out and not err: print("(no output)")
            ssh.close()
            return out
        except Exception as e:
            print(f"  Attempt {attempt+1}/{retries} failed: {e}")
            if attempt < retries - 1:
                time.sleep(3)
    print("  All retries failed!")
    return ""

# 1. 检查后端进程
run("1. 检查后端进程", "ps aux | grep uvicorn | grep -v grep")

# 2. 查看崩溃日志
run("2. 查看崩溃日志", "tail -50 /tmp/backend.log 2>/dev/null || echo '/tmp/backend.log not found'")

# 3. 杀掉旧进程 + 重启
run("3. 杀掉旧进程并重启",
    "pkill -f 'uvicorn.*app.main' || true; "
    "sleep 2; "
    "cd /home/admin/Google-Data-Analysis/backend; "
    "source venv/bin/activate; "
    "nohup uvicorn app.main:app --host 0.0.0.0 --port 8000 --workers 1 > /tmp/backend.log 2>&1 &",
    timeout=15
)

# 4. 等待启动
print(f"\n[等待 6 秒...]")
time.sleep(6)

# 5. Health check
result = run("4. Health check", "curl -s -m 10 http://127.0.0.1:8000/health")

# 6. 确认进程
run("5. 确认进程状态", "ps aux | grep uvicorn | grep -v grep")

# 7. 查看启动日志
run("6. 启动日志", "tail -20 /tmp/backend.log")

if '"status":"ok"' in (result or '') or '"ok"' in (result or ''):
    print("\n✅ 后端重启成功！")
else:
    print("\n⚠️ Health check 未返回 ok，请检查日志")
