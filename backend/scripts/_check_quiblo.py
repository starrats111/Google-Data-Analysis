"""Check quiblo: does it have same conflict issue?"""
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

qb = "/www/wwwroot/quiblo.top"

print("=== quiblo article.html script tags ===")
print(r(f"grep 'script' {qb}/article.html"))

print("\n=== quiblo script.js: what variables? ===")
print(r(f"grep -n 'const \\|var \\|let ' {qb}/script.js | head -20"))

print("\n=== quiblo data.js head ===")
print(r(f"head -20 {qb}/data.js 2>/dev/null || echo 'NOT FOUND'"))

print("\n=== quiblo script.js article loading ===")
print(r(f"grep -n 'blogPosts\\|articlesData\\|articlesIndex\\|loadArticle\\|titleToSlug\\|get(' {qb}/script.js | head -20"))

print("\n=== quiblo articles-index.js ===")
print(r(f"cat {qb}/js/articles-index.js"))

bt.close()
