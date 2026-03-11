"""Read articles-index.js from server"""
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

# Read full articles-index.js
content = run("cat /www/wwwroot/zontri.top/js/articles-index.js")
print(content[:3000])
print("\n... (truncated) ...")
print(content[-500:])

ssh.close()
