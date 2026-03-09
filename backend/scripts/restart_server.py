"""重启后端服务器"""
import paramiko
import time

HOST = "47.239.193.33"
PORT = 22
USER = "admin"
PASS = "A123456"

client = paramiko.SSHClient()
client.set_missing_host_key_policy(paramiko.AutoAddPolicy())
client.connect(HOST, PORT, USER, PASS, timeout=10)

def run(cmd, timeout=60):
    stdin, stdout, stderr = client.exec_command(cmd, timeout=timeout)
    return stdout.read().decode('utf-8', errors='replace'), stderr.read().decode('utf-8', errors='replace')

print("1. 杀掉旧进程...")
out, _ = run("pkill -f 'uvicorn app.main' 2>/dev/null; sleep 1; pgrep -f uvicorn || echo 'killed'")
print(out)

print("2. 确认代码是最新...")
out, _ = run("cd /home/admin/Google-Data-Analysis && git log --oneline -3")
print(out)

print("3. 启动后端...")
channel = client.get_transport().open_session()
channel.exec_command("cd /home/admin/Google-Data-Analysis/backend && nohup python3 -m uvicorn app.main:app --host 0.0.0.0 --port 8000 > /tmp/uvicorn.log 2>&1 &")
time.sleep(8)
print("等待启动...")

print("4. Health check...")
out, _ = run("curl -s http://localhost:8000/health 2>/dev/null")
print(f"Health: {out}")

if '{"status":"ok"}' not in out:
    print("后端未启动，检查日志...")
    out, _ = run("tail -30 /tmp/uvicorn.log")
    print(out)
else:
    print("\n5. 测试公开 API...")
    out, _ = run("curl -s 'http://localhost:8000/api/public/articles/aura-bloom.top' 2>/dev/null | head -20")
    print(out[:1500])

client.close()
