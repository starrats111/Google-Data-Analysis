import paramiko, time
ssh = paramiko.SSHClient()
ssh.set_missing_host_key_policy(paramiko.AutoAddPolicy())
ssh.connect('47.239.193.33', port=22, username='admin', password='A123456', timeout=15)
ssh.exec_command('pkill -f uvicorn', timeout=10)
time.sleep(2)
stdin, stdout, stderr = ssh.exec_command('cd /home/admin/Google-Data-Analysis/backend && source venv/bin/activate && nohup python -m uvicorn app.main:app --host 0.0.0.0 --port 8000 --workers 2 > /home/admin/backend.log 2>&1 & echo STARTED', timeout=10)
print(stdout.read().decode())
ssh.close()
