import paramiko, sys
sys.stdout.reconfigure(encoding='utf-8')
ssh = paramiko.SSHClient()
ssh.set_missing_host_key_policy(paramiko.AutoAddPolicy())
ssh.connect('47.239.193.33', username='admin', password='A123456', timeout=10)

# Check log file size
stdin, stdout, stderr = ssh.exec_command('ls -la /tmp/resync_log.txt /tmp/resync_result.json 2>/dev/null', timeout=10)
print("Files:", stdout.read().decode().strip())

# Check /proc info for the running process
stdin, stdout, stderr = ssh.exec_command('ls -la /proc/77039/fd/ 2>/dev/null | head -20', timeout=10)
print("\nFDs:", stdout.read().decode().strip())

# Check process status
stdin, stdout, stderr = ssh.exec_command('cat /proc/77039/status 2>/dev/null | head -15', timeout=10)
print("\nProc status:", stdout.read().decode().strip())

# Check strace or network connections
stdin, stdout, stderr = ssh.exec_command('ss -tp | grep 77039 2>/dev/null | head -10', timeout=10)
print("\nNetwork:", stdout.read().decode().strip())

# Check backend log for sync activity
stdin, stdout, stderr = ssh.exec_command('tail -30 /home/admin/backend.log 2>/dev/null', timeout=10)
print("\nBackend log tail:", stdout.read().decode('utf-8', errors='replace')[-2000:])

ssh.close()
