import paramiko, sys
sys.stdout.reconfigure(encoding='utf-8')
ssh = paramiko.SSHClient()
ssh.set_missing_host_key_policy(paramiko.AutoAddPolicy())
ssh.connect('47.239.193.33', username='admin', password='A123456', timeout=15)

# Check if analyzeUrl fallback exists in deployed code
_, o, _ = ssh.exec_command("grep -n 'analyzeUrl\\|analyze_url\\|图片相关性过滤' /home/admin/Google-Data-Analysis/backend/app/api/article_gen.py", timeout=10)
print("=== article_gen.py (server) ===")
print(o.read().decode('utf-8', errors='replace').strip())

_, o, _ = ssh.exec_command("grep -n 'testimonial\\|social-proof\\|同域名' /home/admin/Google-Data-Analysis/backend/app/services/merchant_crawler.py", timeout=10)
print("\n=== merchant_crawler.py (server) ===")
print(o.read().decode('utf-8', errors='replace').strip())

# Check process
_, o, _ = ssh.exec_command("ps aux | grep uvicorn | grep -v grep", timeout=10)
print("\n=== Process ===")
print(o.read().decode('utf-8', errors='replace').strip())

ssh.close()
