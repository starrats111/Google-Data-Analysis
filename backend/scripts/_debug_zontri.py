"""Debug zontri server file structure"""
import paramiko, sys
sys.stdout.reconfigure(encoding='utf-8')

BT_HOST = '52.74.221.116'
BT_USER = 'ubuntu'
BT_KEY = r'C:\Users\Administrator\Desktop\密钥\awssg0306.pem'

ssh = paramiko.SSHClient()
ssh.set_missing_host_key_policy(paramiko.AutoAddPolicy())
pkey = paramiko.RSAKey.from_private_key_file(BT_KEY)
ssh.connect(BT_HOST, username=BT_USER, pkey=pkey, timeout=15)

def run(cmd, timeout=10):
    _, stdout, stderr = ssh.exec_command(cmd, timeout=timeout)
    return stdout.read().decode('utf-8', errors='replace').strip()

# List all JS files
print("=== JS files ===")
print(run("ls -la /www/wwwroot/zontri.top/js/"))

# Check which files article.html loads
print("\n=== article.html script tags ===")
print(run("grep 'script' /www/wwwroot/zontri.top/article.html"))

# Check data.js first 10 lines
print("\n=== data.js first 10 lines ===")
print(run("head -10 /www/wwwroot/zontri.top/js/data.js"))

# Check if articles-index.js exists
print("\n=== articles-index.js exists? ===")
print(run("ls -la /www/wwwroot/zontri.top/js/articles-index.js 2>/dev/null || echo 'NOT FOUND'"))

# Check main.js - how does it find articles
print("\n=== main.js: indexData source ===")
print(run("grep -n 'articlesIndex\\|indexData\\|const articles\\|var articles' /www/wwwroot/zontri.top/js/main.js | head -10"))

# Check data.js - does it have articlesIndex?
print("\n=== data.js: articlesIndex? ===")
print(run("grep -n 'articlesIndex' /www/wwwroot/zontri.top/js/data.js | head -5"))

# data.js total lines
print("\n=== data.js total lines ===")
print(run("wc -l /www/wwwroot/zontri.top/js/data.js"))

ssh.close()
