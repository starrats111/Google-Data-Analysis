"""Update cache buster for articles-index.js on zontri.top"""
import paramiko, sys, time
sys.stdout.reconfigure(encoding='utf-8')

BT_HOST = '52.74.221.116'
BT_USER = 'ubuntu'
BT_KEY = r'C:\Users\Administrator\Desktop\密钥\awssg0306.pem'

ssh = paramiko.SSHClient()
ssh.set_missing_host_key_policy(paramiko.AutoAddPolicy())
pkey = paramiko.RSAKey.from_private_key_file(BT_KEY)
ssh.connect(BT_HOST, username=BT_USER, pkey=pkey, timeout=15)

sftp = ssh.open_sftp()

# Update article.html cache buster
with sftp.open('/www/wwwroot/zontri.top/article.html', 'r') as f:
    html = f.read().decode('utf-8')

new_version = str(int(time.time()))
# Replace old version parameter
import re
html = re.sub(r'articles-index\.js\?v=\d+', f'articles-index.js?v={new_version}', html)
# If no version param, add one
if f'?v={new_version}' not in html and 'articles-index.js' in html:
    html = html.replace('articles-index.js"', f'articles-index.js?v={new_version}"')
    html = html.replace("articles-index.js'", f"articles-index.js?v={new_version}'")

with sftp.open('/www/wwwroot/zontri.top/article.html', 'w') as f:
    f.write(html.encode('utf-8'))

print(f"✓ Updated cache buster to v={new_version}")

# Also update articles.html if it exists
try:
    with sftp.open('/www/wwwroot/zontri.top/articles.html', 'r') as f:
        html2 = f.read().decode('utf-8')
    html2 = re.sub(r'articles-index\.js\?v=\d+', f'articles-index.js?v={new_version}', html2)
    with sftp.open('/www/wwwroot/zontri.top/articles.html', 'w') as f:
        f.write(html2.encode('utf-8'))
    print("✓ Updated articles.html cache buster too")
except:
    pass

# Also update index.html
try:
    with sftp.open('/www/wwwroot/zontri.top/index.html', 'r') as f:
        html3 = f.read().decode('utf-8')
    html3 = re.sub(r'articles-index\.js\?v=\d+', f'articles-index.js?v={new_version}', html3)
    with sftp.open('/www/wwwroot/zontri.top/index.html', 'w') as f:
        f.write(html3.encode('utf-8'))
    print("✓ Updated index.html cache buster too")
except:
    pass

sftp.close()

# Verify by checking the article page
def run(cmd, timeout=10):
    _, stdout, stderr = ssh.exec_command(cmd, timeout=timeout)
    return stdout.read().decode('utf-8', errors='replace').strip()

print("\n=== Testing article page ===")
print(run("grep 'articles-index' /www/wwwroot/zontri.top/article.html"))

ssh.close()
print("\nDone!")
