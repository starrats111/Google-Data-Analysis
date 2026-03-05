import paramiko
ssh = paramiko.SSHClient()
ssh.set_missing_host_key_policy(paramiko.AutoAddPolicy())
ssh.connect('47.239.193.33', port=22, username='admin', password='A123456', timeout=15)
stdin, stdout, stderr = ssh.exec_command('cd /home/admin/Google-Data-Analysis && git pull origin main 2>&1', timeout=30)
print(stdout.read().decode())
ssh.close()
