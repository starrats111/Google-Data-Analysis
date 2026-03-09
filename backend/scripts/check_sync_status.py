import paramiko
ssh = paramiko.SSHClient()
ssh.set_missing_host_key_policy(paramiko.AutoAddPolicy())
ssh.connect('47.239.193.33', 22, 'admin', 'A123456', timeout=15)

# Check process state
i, o, e = ssh.exec_command('ps aux | grep run_merchant_sync | grep -v grep')
print('Process:')
print(o.read().decode())

# Check /proc status
i, o, e = ssh.exec_command('cat /proc/5833/status 2>/dev/null | head -10')
print('Status:')
print(o.read().decode())

# Check if it's stuck on network
i, o, e = ssh.exec_command('cat /proc/5833/wchan 2>/dev/null')
print('Wchan:', o.read().decode())

ssh.close()
