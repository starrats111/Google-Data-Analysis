"""验证部署状态"""
import paramiko
import time

HOST = "47.239.193.33"
PORT = 22
USER = "admin"
PASS = "A123456"

def ssh_exec(cmd, timeout=60):
    client = paramiko.SSHClient()
    client.set_missing_host_key_policy(paramiko.AutoAddPolicy())
    client.connect(HOST, PORT, USER, PASS, timeout=10)
    stdin, stdout, stderr = client.exec_command(cmd, timeout=timeout)
    out = stdout.read().decode('utf-8', errors='replace')
    err = stderr.read().decode('utf-8', errors='replace')
    client.close()
    return out, err

print("1. 检查后端进程...")
out, err = ssh_exec("ps aux | grep uvicorn | grep -v grep")
print(out or "(未运行)")

print("\n2. 重启后端...")
out, err = ssh_exec("cd /home/admin/Google-Data-Analysis/backend && pkill -f 'uvicorn app.main' 2>/dev/null; sleep 2 && nohup python3 -m uvicorn app.main:app --host 0.0.0.0 --port 8000 > /tmp/uvicorn.log 2>&1 &")
print("已发送重启命令")
time.sleep(5)

print("\n3. Health check...")
out, err = ssh_exec("curl -s http://localhost:8000/health")
print(out or "(无响应)")

print("\n4. 测试公开 API...")
out, err = ssh_exec("curl -s 'http://localhost:8000/api/public/articles/aura-bloom.top' 2>/dev/null")
print(out[:1000] if out else "(无响应)")

print("\n5. 检查启动日志...")
out, err = ssh_exec("tail -20 /tmp/uvicorn.log")
print(out[:2000])
