"""快速部署：拉取代码 + 重启后端"""
import paramiko, time

ssh = paramiko.SSHClient()
ssh.set_missing_host_key_policy(paramiko.AutoAddPolicy())
ssh.connect('47.239.193.33', port=22, username='admin', password='A123456', timeout=15)

stdin, stdout, stderr = ssh.exec_command('cd /home/admin/Google-Data-Analysis && git pull origin main 2>&1')
print("Pull:", stdout.read().decode().strip()[-200:])

stdin, stdout, stderr = ssh.exec_command('pkill -f uvicorn; sleep 2; echo OK')
stdout.read()
time.sleep(3)

stdin, stdout, stderr = ssh.exec_command('cd /home/admin/Google-Data-Analysis/backend && source venv/bin/activate && nohup python -m uvicorn app.main:app --host 0.0.0.0 --port 8000 --workers 2 > /home/admin/backend.log 2>&1 & echo STARTED')
print("Start:", stdout.read().decode().strip())
time.sleep(5)

ssh2 = paramiko.SSHClient()
ssh2.set_missing_host_key_policy(paramiko.AutoAddPolicy())
ssh2.connect('47.239.193.33', port=22, username='admin', password='A123456', timeout=15)
stdin, stdout, stderr = ssh2.exec_command('curl -s -o /dev/null -w "%{http_code}" http://localhost:8000/health')
print("Health:", stdout.read().decode().strip())
ssh2.close()
