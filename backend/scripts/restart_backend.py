import paramiko
import time

ssh = paramiko.SSHClient()
ssh.set_missing_host_key_policy(paramiko.AutoAddPolicy())
ssh.connect('47.239.193.33', port=22, username='admin', password='A123456', timeout=15)

# 启动后端
stdin, stdout, stderr = ssh.exec_command('cd /home/admin/Google-Data-Analysis/backend && source venv/bin/activate && nohup python -m uvicorn app.main:app --host 0.0.0.0 --port 8000 --workers 2 > /home/admin/backend.log 2>&1 & echo STARTED')
print(stdout.read().decode())
time.sleep(5)

# 验证进程
stdin, stdout, stderr = ssh.exec_command('ps aux | grep uvicorn | grep -v grep')
result = stdout.read().decode()
print('uvicorn进程:')
print(result)

# 测试API
stdin, stdout, stderr = ssh.exec_command('curl -s -o /dev/null -w "%{http_code}" http://localhost:8000/health')
print('健康检查状态码:', stdout.read().decode())

ssh.close()
