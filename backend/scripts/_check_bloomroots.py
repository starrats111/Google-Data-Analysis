"""Check bloomroots: verify articles-index.js has all articles, check article.html loading"""
import paramiko, sys
sys.stdout.reconfigure(encoding='utf-8')
pkey = paramiko.RSAKey.from_private_key_file(r"C:\Users\Administrator\Desktop\密钥\awssg0306.pem")
bt = paramiko.SSHClient()
bt.set_missing_host_key_policy(paramiko.AutoAddPolicy())
bt.connect("52.74.221.116", 22, "ubuntu", pkey=pkey, timeout=15)
def r(cmd, t=15):
    stdin, stdout, stderr = bt.exec_command(cmd, timeout=t)
    stdout.channel.recv_exit_status()
    return stdout.read().decode('utf-8', errors='replace').strip()

br = "/www/wwwroot/bloomroots.top"

print("=== articles-index.js full content ===")
print(r(f"cat {br}/js/articles-index.js"))

print("\n=== script.js first 100 lines ===")
print(r(f"head -100 {br}/script.js"))

print("\n=== article.html script tags ===")
print(r(f"grep -n 'script' {br}/article.html"))

print("\n=== article.html: how does it load article? ===")
# Check if article.html has inline JS that loads article
print(r(f"grep -A5 'DOMContentLoaded\\|urlParam\\|URLSearch\\|get(' {br}/article.html | head -30"))

print("\n=== js/articles/ directory ===")
print(r(f"ls -la {br}/js/articles/ 2>/dev/null || echo 'NOT FOUND'"))

print("\n=== Check what script.js uses for article detail ===")
print(r(f"grep -n 'article\\.html\\|articleContent\\|loadArticle\\|displayArticle\\|urlParam\\|URLSearch\\|get(' {br}/script.js | head -20"))

bt.close()
