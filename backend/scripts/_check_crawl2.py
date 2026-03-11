import paramiko, sys
sys.stdout.reconfigure(encoding='utf-8')
ssh = paramiko.SSHClient()
ssh.set_missing_host_key_policy(paramiko.AutoAddPolicy())
ssh.connect('47.239.193.33', username='admin', password='A123456', timeout=10)

# Check app.log for crawl 
stdin, stdout, stderr = ssh.exec_command(
    'grep -i "crawl\\|image\\|MerchantCrawler\\|ImageSearch" /home/admin/Google-Data-Analysis/backend/logs/app.log 2>/dev/null | tail -40',
    timeout=15
)
log = stdout.read().decode('utf-8', errors='replace')
print("=== app.log crawl entries ===")
print(log if log else "(none)")

# Check error.log
stdin, stdout, stderr = ssh.exec_command(
    'tail -60 /home/admin/Google-Data-Analysis/backend/logs/error.log 2>/dev/null',
    timeout=15
)
elog = stdout.read().decode('utf-8', errors='replace')
print(f"\n=== error.log tail ===\n{elog[-3000:]}")

# Check the actual running uvicorn process and its log
stdin, stdout, stderr = ssh.exec_command(
    'ps aux | grep uvicorn | grep -v grep',
    timeout=5
)
print(f"\n=== uvicorn processes ===\n{stdout.read().decode().strip()}")

# Check which port 8000 is actually listening on 
stdin, stdout, stderr = ssh.exec_command('ss -tlnp | grep 8000', timeout=5)
print(f"\n=== Port 8000 ===\n{stdout.read().decode().strip()}")

# Try to get the actual working uvicorn log
stdin, stdout, stderr = ssh.exec_command(
    'ls -lt /home/admin/*.log /home/admin/Google-Data-Analysis/backend/*.log 2>/dev/null | head -10',
    timeout=5
)
print(f"\n=== Log files ===\n{stdout.read().decode().strip()}")

ssh.close()
