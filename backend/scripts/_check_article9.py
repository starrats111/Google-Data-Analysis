"""Check zontri article 9 content on server"""
import paramiko, sys, json
sys.stdout.reconfigure(encoding='utf-8')

BT_HOST = '52.74.221.116'
BT_USER = 'ubuntu'
BT_KEY = r'C:\Users\Administrator\Desktop\密钥\awssg0306.pem'

ssh = paramiko.SSHClient()
ssh.set_missing_host_key_policy(paramiko.AutoAddPolicy())
pkey = paramiko.RSAKey.from_private_key_file(BT_KEY)
ssh.connect(BT_HOST, username=BT_USER, pkey=pkey, timeout=15)

def run(cmd, timeout=10):
    _, stdout, _ = ssh.exec_command(cmd, timeout=timeout)
    return stdout.read().decode('utf-8', errors='replace').strip()

# Read article JSON
raw = run("cat /www/wwwroot/zontri.top/js/articles/9.json")
article = json.loads(raw)

print("Title:", article['title'])
print("Author:", article.get('author'))
print("Date:", article['date'])
print("\n=== Content (links) ===")
# Find all links in content
import re
links = re.findall(r'<a\s+[^>]*href=["\']([^"\']+)["\'][^>]*>([^<]*)</a>', article['content'])
for url, text in links:
    print(f"  [{text}] -> {url}")

print(f"\nTotal links: {len(links)}")
print("\n=== Full content ===")
print(article['content'])

ssh.close()
