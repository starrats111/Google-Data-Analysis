import paramiko, sys
sys.stdout.reconfigure(encoding='utf-8')
ssh = paramiko.SSHClient()
ssh.set_missing_host_key_policy(paramiko.AutoAddPolicy())
ssh.connect('47.239.193.33', username='admin', password='A123456', timeout=10)

# Check recent crawl-related logs
stdin, stdout, stderr = ssh.exec_command(
    'grep -i "crawl\\|ImageSearch\\|image\\|merchant_crawler" /home/admin/backend.log 2>/dev/null | tail -50',
    timeout=15
)
print("=== Crawl logs ===")
print(stdout.read().decode('utf-8', errors='replace'))

# Check if Pexels API key is configured
stdin, stdout, stderr = ssh.exec_command(
    'grep -i "pexels\\|PEXELS" /home/admin/Google-Data-Analysis/backend/.env 2>/dev/null',
    timeout=10
)
print("=== Pexels config ===")
out = stdout.read().decode('utf-8', errors='replace').strip()
print(out if out else "(not found)")

# Check config.py for pexels
stdin, stdout, stderr = ssh.exec_command(
    'grep -i "pexels" /home/admin/Google-Data-Analysis/backend/app/config.py 2>/dev/null',
    timeout=10
)
print("\n=== Config pexels ===")
out = stdout.read().decode('utf-8', errors='replace').strip()
print(out if out else "(not found)")

# Check nohup.out or any other log files
stdin, stdout, stderr = ssh.exec_command(
    'grep -i "crawl\\|ImageSearch" /home/admin/nohup.out 2>/dev/null | tail -30',
    timeout=15
)
print("\n=== nohup.out crawl logs ===")
print(stdout.read().decode('utf-8', errors='replace'))

ssh.close()
