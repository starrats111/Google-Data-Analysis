import paramiko
ssh = paramiko.SSHClient()
ssh.set_missing_host_key_policy(paramiko.AutoAddPolicy())
ssh.connect('47.239.193.33', 22, 'admin', 'A123456', timeout=30, banner_timeout=60, allow_agent=False, look_for_keys=False)
i, o, e = ssh.exec_command('curl -s -m 10 http://localhost:8000/health', timeout=30)
print(o.read().decode(errors='replace').strip())
ssh.close()
