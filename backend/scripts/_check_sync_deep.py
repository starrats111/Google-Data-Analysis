import paramiko, sys
sys.stdout.reconfigure(encoding='utf-8')
ssh = paramiko.SSHClient()
ssh.set_missing_host_key_policy(paramiko.AutoAddPolicy())
ssh.connect('47.239.193.33', username='admin', password='A123456', timeout=10)

# Check log file size & modification time
stdin, stdout, stderr = ssh.exec_command('stat /tmp/resync_log.txt 2>/dev/null', timeout=10)
print("Log file stat:", stdout.read().decode().strip())

# Check line count
stdin, stdout, stderr = ssh.exec_command('wc -l /tmp/resync_log.txt 2>/dev/null', timeout=5)
print("\nLog lines:", stdout.read().decode().strip())

# Check network connections for process
stdin, stdout, stderr = ssh.exec_command('ss -tp | grep 77039 2>/dev/null', timeout=5)
net = stdout.read().decode().strip()
print(f"\nNetwork connections:\n{net if net else 'No connections'}")

# Check strace for what the process is doing (quick peek)
stdin, stdout, stderr = ssh.exec_command('timeout 3 strace -p 77039 -e trace=network,read,write 2>&1 | head -30', timeout=10)
strace = stdout.read().decode('utf-8', errors='replace').strip()
print(f"\nStrace:\n{strace}")

# Check if database has been growing
stdin, stdout, stderr = ssh.exec_command('ls -la /home/admin/Google-Data-Analysis/backend/google_analysis.db*', timeout=5)
print(f"\nDB files:\n{stdout.read().decode().strip()}")

ssh.close()
