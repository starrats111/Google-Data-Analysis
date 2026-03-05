"""最终验证"""
import paramiko

ssh = paramiko.SSHClient()
ssh.set_missing_host_key_policy(paramiko.AutoAddPolicy())
ssh.connect('47.239.193.33', port=22, username='admin', password='A123456', timeout=15)

stdin, stdout, stderr = ssh.exec_command('ps aux | grep uvicorn | grep -v grep')
procs = stdout.read().decode()
print("Processes:", "OK" if "uvicorn" in procs else "MISSING")

stdin, stdout, stderr = ssh.exec_command('curl -s -o /dev/null -w "%{http_code}" http://localhost:8000/health')
code = stdout.read().decode().strip()
print("Health:", code)

stdin, stdout, stderr = ssh.exec_command('grep api_key /home/admin/Google-Data-Analysis/backend/.env | head -2')
print("Keys:", stdout.read().decode().strip())

ssh.close()
