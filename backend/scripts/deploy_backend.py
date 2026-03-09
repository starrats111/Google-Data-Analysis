"""部署后端到服务器"""
import paramiko

HOST = "47.239.193.33"
PORT = 22
USER = "admin"
PASS = "A123456"

def ssh_exec(cmd, timeout=120):
    client = paramiko.SSHClient()
    client.set_missing_host_key_policy(paramiko.AutoAddPolicy())
    client.connect(HOST, PORT, USER, PASS, timeout=10)
    stdin, stdout, stderr = client.exec_command(cmd, timeout=timeout)
    out = stdout.read().decode('utf-8', errors='replace')
    err = stderr.read().decode('utf-8', errors='replace')
    client.close()
    return out, err

print("1. 拉取最新代码...")
out, err = ssh_exec("cd /home/admin/Google-Data-Analysis && git pull origin main")
print(out)
if err:
    print("ERR:", err[:500])

print("\n2. 重启后端服务...")
out, err = ssh_exec("pkill -f 'uvicorn app.main' 2>/dev/null; sleep 2; cd /home/admin/Google-Data-Analysis/backend && nohup python3 -m uvicorn app.main:app --host 0.0.0.0 --port 8000 > /tmp/uvicorn.log 2>&1 & sleep 3 && curl -s http://localhost:8000/health")
print(out)
if err:
    print("ERR:", err[:500])

print("\n3. 测试公开 API...")
out, err = ssh_exec("curl -s http://localhost:8000/api/public/articles/aura-bloom.top | python3 -m json.tool 2>/dev/null | head -30")
print(out)
