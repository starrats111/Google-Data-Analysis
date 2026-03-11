"""Restart backend with correct key (hd.pem)"""
import paramiko, time, sys
sys.stdout.reconfigure(encoding='utf-8')

key_path = r"C:\Users\Administrator\Desktop\密钥\hd.pem"

# Try different key types
pkey = None
for loader in [paramiko.Ed25519Key, paramiko.RSAKey, paramiko.ECDSAKey]:
    try:
        pkey = loader.from_private_key_file(key_path)
        print(f"Key loaded as {loader.__name__}")
        break
    except Exception as e:
        print(f"{loader.__name__}: {e}")

if not pkey:
    print("ERROR: Cannot load key")
    sys.exit(1)

ssh = paramiko.SSHClient()
ssh.set_missing_host_key_policy(paramiko.AutoAddPolicy())
ssh.connect('47.239.193.33', port=22, username='admin', pkey=pkey, timeout=15)
print("Connected!")

# Kill + restart
cmd = """pkill -f 'uvicorn app.main:app' 2>/dev/null; sleep 2; \
cd /home/admin/Google-Data-Analysis/backend && \
source venv/bin/activate && \
nohup python -m uvicorn app.main:app --host 0.0.0.0 --port 8000 --workers 2 \
>> /home/admin/backend.log 2>&1 & \
disown && echo "PID: $!"
"""

transport = ssh.get_transport()
channel = transport.open_session()
channel.exec_command(cmd)

time.sleep(4)
if channel.recv_ready():
    print(channel.recv(4096).decode())
channel.close()

print("等待服务启动...")
time.sleep(8)

# Verify
stdin, stdout, stderr = ssh.exec_command('ps aux | grep uvicorn | grep -v grep', timeout=10)
result = stdout.read().decode()
print('uvicorn进程:')
print(result.strip() if result.strip() else '(无)')

stdin, stdout, stderr = ssh.exec_command('curl -s -m 5 http://localhost:8000/health', timeout=10)
print('健康检查:', stdout.read().decode().strip())

ssh.close()
print("✅ 完成")
