"""Check vitasphere article detail function"""
import paramiko, sys
sys.stdout.reconfigure(encoding='utf-8')
pkey = paramiko.RSAKey.from_private_key_file(r"C:\Users\Administrator\Desktop\密钥\awssg0306.pem")
bt = paramiko.SSHClient()
bt.set_missing_host_key_policy(paramiko.AutoAddPolicy())
bt.connect("52.74.221.116", 22, "ubuntu", pkey=pkey, timeout=15)
def r(cmd, t=10):
    stdin, stdout, stderr = bt.exec_command(cmd, timeout=t)
    stdout.channel.recv_exit_status()
    return stdout.read().decode('utf-8', errors='replace').strip()

vs = "/www/wwwroot/vitasphere.top"
print("=== vitasphere.top article detail ===")

# Find the article detail function
line_nums = r(f"grep -n 'displayArticle\\|loadArticle\\|ArticleDetail\\|showArticle\\|renderArticle' {vs}/js/main.js | head -10")
print(f"Function locations: {line_nums}")

# Get displayArticlePage function and surrounding code
print("\n--- Article page functions ---")
print(r(f"sed -n '220,290p' {vs}/js/main.js"))

# Check generateSlug
print("\n--- generateSlug ---")
print(r(f"grep -n -A 5 'generateSlug' {vs}/js/main.js"))

# Check URL param
print("\n--- URL param ---")
print(r(f"grep -n 'get(' {vs}/js/main.js | head -10"))

# Also check bloomroots and quiblo
for domain in ["bloomroots.top", "quiblo.top"]:
    root = f"/www/wwwroot/{domain}"
    print(f"\n=== {domain} article detail ===")
    # Check script.js for article detail 
    print(r(f"grep -n 'displayArticle\\|loadArticle\\|ArticleDetail\\|showArticle\\|renderArticle' {root}/script.js 2>/dev/null | head -10"))
    print(r(f"grep -n 'fetch\\|json\\|JSON\\|content' {root}/script.js 2>/dev/null | head -20"))

bt.close()
