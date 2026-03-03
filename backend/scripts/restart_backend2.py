import paramiko
import time

ssh = paramiko.SSHClient()
ssh.set_missing_host_key_policy(paramiko.AutoAddPolicy())
ssh.connect('47.239.193.33', port=22, username='admin', password='A123456', timeout=15)

# 先杀掉旧进程，再启动新进程（用 bash -c 包裹，避免阻塞）
cmd = "bash -c 'pkill -f uvicorn; sleep 2; cd /home/admin/Google-Data-Analysis/backend && source venv/bin/activate && nohup python -m uvicorn app.main:app --host 0.0.0.0 --port 8000 --workers 2 </dev/null >/home/admin/backend.log 2>&1 &'"
stdin, stdout, stderr = ssh.exec_command(cmd, timeout=15)
stdout.channel.recv_exit_status()
print("启动命令已执行")

time.sleep(6)

# 验证进程
stdin, stdout, stderr = ssh.exec_command('ps aux | grep uvicorn | grep -v grep', timeout=10)
result = stdout.read().decode()
print('uvicorn进程:')
print(result if result.strip() else '(无进程)')

# 测试健康检查
stdin, stdout, stderr = ssh.exec_command('curl -s http://localhost:8000/health', timeout=10)
health = stdout.read().decode()
print('健康检查:', health)

ssh.close()
print("完成")
