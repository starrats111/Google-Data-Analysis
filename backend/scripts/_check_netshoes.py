"""Check backend logs for netshoes crawl attempt"""
import paramiko, sys
sys.stdout.reconfigure(encoding='utf-8')

ssh = paramiko.SSHClient()
ssh.set_missing_host_key_policy(paramiko.AutoAddPolicy())
ssh.connect('47.239.193.33', username='admin', password='A123456', timeout=15)

def run(cmd, timeout=10):
    _, o, _ = ssh.exec_command(cmd, timeout=timeout)
    return o.read().decode('utf-8', errors='replace').strip()

# Check recent logs for netshoes
print("=== Recent netshoes logs ===")
print(run("grep -i 'netshoes\\|crawl.*fail\\|analyze_url\\|图片相关性' /home/admin/backend.log | tail -30"))

# Check if backend is running with new code
print("\n=== Code verification ===")
print("min_width=300:", run("grep -c 'min_width=300' /home/admin/Google-Data-Analysis/backend/app/api/article_gen.py"))
print("crawled_count == 0:", run("grep -c 'crawled_count == 0' /home/admin/Google-Data-Analysis/backend/app/api/article_gen.py"))

# Check the analyze-url endpoint
print("\n=== analyze-url endpoint ===")
print(run("grep -A5 'analyze_url_only' /home/admin/Google-Data-Analysis/backend/app/api/article_gen.py | head -10"))

# Check process
print("\n=== Process ===")
print(run("ps aux | grep uvicorn | grep -v grep"))

# Check if the frontend calls analyzeUrl on crawl failure
print("\n=== Frontend handleManualSubmit ===")
# The frontend is served from a different location, check if it's been deployed
print(run("find /www -name 'articleApi*' 2>/dev/null | head -5"))

ssh.close()
