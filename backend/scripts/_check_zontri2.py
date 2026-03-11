"""Check article JSON and server data.js"""
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
    o = stdout.read().decode('utf-8', errors='replace').strip()
    return o

# Check the article JSON
print("=== Article JSON ===")
print(run("cat /www/wwwroot/zontri.top/articles/the-quiet-art-of-a-well-made-shirt.json"))

print("\n=== js/articles/9.json ===")
print(run("cat /www/wwwroot/zontri.top/js/articles/9.json")[:2000])

# Check server data.js - last few lines and article count
print("\n=== Server data.js article count ===")
print(run("grep -c 'title' /www/wwwroot/zontri.top/js/data.js"))

# Check articles-index.js
print("\n=== Server articles-index.js ===")
print(run("grep 'quiet\\|well-made\\|shirt' /www/wwwroot/zontri.top/js/articles-index.js 2>/dev/null || echo 'Not found in articles-index.js'"))
print(run("grep 'quiet\\|well-made\\|shirt' /www/wwwroot/zontri.top/js/data.js 2>/dev/null || echo 'Not found in data.js'"))

# Check main.js for article loading logic
print("\n=== main.js article fetch logic ===")
print(run("grep -n 'fetch\\|articles/' /www/wwwroot/zontri.top/js/main.js | head -20"))

ssh.close()
