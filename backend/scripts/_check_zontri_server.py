"""Check zontri.top server for article files"""
import paramiko, sys
sys.stdout.reconfigure(encoding='utf-8')

BT_HOST = '52.74.221.116'
BT_USER = 'ubuntu'
BT_KEY = r'C:\Users\Administrator\Desktop\密钥\awssg0306.pem'

ssh = paramiko.SSHClient()
ssh.set_missing_host_key_policy(paramiko.AutoAddPolicy())
pkey = paramiko.RSAKey.from_private_key_file(BT_KEY)
ssh.connect(BT_HOST, username=BT_USER, pkey=pkey, timeout=15)
print("Connected to BT server")

def run(cmd, timeout=10):
    _, stdout, stderr = ssh.exec_command(cmd, timeout=timeout)
    o = stdout.read().decode('utf-8', errors='replace').strip()
    e = stderr.read().decode('utf-8', errors='replace').strip()
    if o: print(o[:5000])
    if e and 'warning' not in e.lower(): print(f'ERR: {e[:500]}')
    return o

# Find zontri site directory
print("=== Finding zontri site ===")
run("sudo find /www/wwwroot -maxdepth 1 -name '*zontri*' -o -name '*Zontri*' 2>/dev/null")
run("sudo ls /www/wwwroot/ 2>/dev/null | grep -i zontri")

# Check for articles directory
print("\n=== Articles directory ===")
run("sudo ls -la /www/wwwroot/zontri.top/articles/ 2>/dev/null || echo 'No articles dir'")
run("sudo ls -la /www/wwwroot/Zontri/articles/ 2>/dev/null || echo 'No Zontri/articles dir'")

# Search for the specific article
print("\n=== Search for quiet-art article ===")
run("sudo find /www/wwwroot -name '*quiet*' -o -name '*well-made*' 2>/dev/null | head -20")
run("sudo grep -rl 'quiet.*art.*well.*made' /www/wwwroot/*zontri* /www/wwwroot/*Zontri* 2>/dev/null | head -10")

# Check data.js on server
print("\n=== data.js on server ===")
run("sudo find /www/wwwroot -path '*zontri*' -name 'data.js' 2>/dev/null")
run("sudo find /www/wwwroot -path '*Zontri*' -name 'data.js' 2>/dev/null")

# List site root
print("\n=== Site root ===")
run("sudo ls /www/wwwroot/ | head -30")

ssh.close()
