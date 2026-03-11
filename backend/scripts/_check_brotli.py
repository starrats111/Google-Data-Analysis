import paramiko, sys
sys.stdout.reconfigure(encoding='utf-8')
ssh = paramiko.SSHClient()
ssh.set_missing_host_key_policy(paramiko.AutoAddPolicy())
ssh.connect('47.239.193.33', username='admin', password='A123456', timeout=10)

cmd = 'cd /home/admin/Google-Data-Analysis/backend && source venv/bin/activate && python3 -c "import brotli; print(brotli.__version__)" 2>&1'
stdin, stdout, stderr = ssh.exec_command(cmd, timeout=15)
print("Brotli check:", stdout.read().decode().strip())

cmd2 = 'cd /home/admin/Google-Data-Analysis/backend && source venv/bin/activate && python3 -c "import httpx; print(httpx.__version__)" 2>&1'
stdin, stdout, stderr = ssh.exec_command(cmd2, timeout=15)
print("httpx version:", stdout.read().decode().strip())

cmd3 = 'cd /home/admin/Google-Data-Analysis/backend && source venv/bin/activate && pip list 2>/dev/null | grep -i brotli'
stdin, stdout, stderr = ssh.exec_command(cmd3, timeout=15)
print("Brotli in pip:", stdout.read().decode().strip())

ssh.close()
