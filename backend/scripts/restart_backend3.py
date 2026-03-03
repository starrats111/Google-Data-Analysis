import paramiko
import time

ssh = paramiko.SSHClient()
ssh.set_missing_host_key_policy(paramiko.AutoAddPolicy())
ssh.connect('47.239.193.33', port=22, username='admin', password='A123456', timeout=15)

# 使用 screen 或 disown 方式启动，避免 nohup 阻塞
cmd = """cd /home/admin/Google-Data-Analysis/backend && \
source venv/bin/activate && \
nohup python -m uvicorn app.main:app --host 0.0.0.0 --port 8000 --workers 2 \
>> /home/admin/backend.log 2>&1 & \
disown && echo "PID: $!"
"""

transport = ssh.get_transport()
channel = transport.open_session()
channel.exec_command(cmd)

# 等待一小段时间获取输出
time.sleep(3)
if channel.recv_ready():
    print(channel.recv(4096).decode())
if channel.recv_stderr_ready():
    print("STDERR:", channel.recv_stderr(4096).decode())

channel.close()

# 等待服务启动
print("等待服务启动...")
time.sleep(8)

# 验证
stdin, stdout, stderr = ssh.exec_command('ps aux | grep uvicorn | grep -v grep', timeout=10)
result = stdout.read().decode()
print('uvicorn进程:')
print(result if result.strip() else '(无进程)')

stdin, stdout, stderr = ssh.exec_command('curl -s -m 5 http://localhost:8000/health', timeout=10)
health = stdout.read().decode()
print('健康检查:', health if health.strip() else '(无响应)')

# 查看启动日志
stdin, stdout, stderr = ssh.exec_command('tail -10 /home/admin/backend.log', timeout=10)
print('最新日志:')
print(stdout.read().decode())

ssh.close()
print("完成")
