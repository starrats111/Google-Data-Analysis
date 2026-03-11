import paramiko, sys
sys.stdout.reconfigure(encoding='utf-8')
ssh = paramiko.SSHClient()
ssh.set_missing_host_key_policy(paramiko.AutoAddPolicy())
ssh.connect('47.239.193.33', username='admin', password='A123456', timeout=10)

# Check recent backend logs for crawl activity
stdin, stdout, stderr = ssh.exec_command(
    'grep -i "crawl\\|MerchantCrawler\\|crawl_failed\\|images" /home/admin/backend.log 2>/dev/null | tail -40',
    timeout=15
)
log = stdout.read().decode('utf-8', errors='replace')
print("=== Recent crawl logs ===")
print(log if log else "(no crawl entries found)")

# Check nohup.out or other logs
stdin, stdout, stderr = ssh.exec_command(
    'grep -i "crawl\\|MerchantCrawler" /home/admin/nohup.out 2>/dev/null | tail -20',
    timeout=15
)
log2 = stdout.read().decode('utf-8', errors='replace')
if log2:
    print("\n=== nohup.out crawl logs ===")
    print(log2)

# Find other log files
stdin, stdout, stderr = ssh.exec_command(
    'find /home/admin -name "*.log" -mmin -60 2>/dev/null | head -10',
    timeout=10
)
print("\n=== Recent log files ===")
print(stdout.read().decode().strip())

# Check if uvicorn logs to stdout
stdin, stdout, stderr = ssh.exec_command(
    'cat /home/admin/backend.log 2>/dev/null | tail -80',
    timeout=15
)
log3 = stdout.read().decode('utf-8', errors='replace')
print(f"\n=== Backend log tail ===\n{log3[-3000:]}")

ssh.close()
