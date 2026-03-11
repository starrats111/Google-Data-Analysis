import paramiko, sys
sys.stdout.reconfigure(encoding='utf-8')
ssh = paramiko.SSHClient()
ssh.set_missing_host_key_policy(paramiko.AutoAddPolicy())
ssh.connect('47.239.193.33', username='admin', password='A123456', timeout=10)

def run(cmd, timeout=30):
    stdin, stdout, stderr = ssh.exec_command(cmd, timeout=timeout)
    return stdout.read().decode('utf-8', errors='replace'), stderr.read().decode('utf-8', errors='replace')

# 1. Check recent backend logs for crawl activity
print("=== 最近后端日志（爬取相关）===")
out, _ = run("grep -i 'crawl\\|ImageSearch\\|MerchantCrawler\\|品牌' /home/admin/backend.log 2>/dev/null | tail -30")
print(out if out.strip() else "(无匹配日志)")

# 2. Check full backend log tail for recent requests
print("\n=== 最近后端请求日志 ===")
out, _ = run("tail -50 /home/admin/backend.log 2>/dev/null")
print(out[-3000:])

# 3. Check for any error logs
print("\n=== 错误日志 ===")
out, _ = run("grep -i 'error\\|exception\\|traceback\\|failed' /home/admin/backend.log 2>/dev/null | tail -20")
print(out if out.strip() else "(无错误)")

# 4. Check if the frontend build deployed (Cloudflare Pages auto-deploys from GitHub)
print("\n=== Git log (latest commit) ===")
out, _ = run("cd /home/admin/Google-Data-Analysis && git log --oneline -3")
print(out)

ssh.close()
