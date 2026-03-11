"""Check backend server directory structure"""
import paramiko, sys
sys.stdout.reconfigure(encoding='utf-8')

ssh = paramiko.SSHClient()
ssh.set_missing_host_key_policy(paramiko.AutoAddPolicy())
ssh.connect('47.239.193.33', username='admin', password='A123456', timeout=30)

def run(cmd):
    stdin, stdout, stderr = ssh.exec_command(cmd, timeout=15)
    o = stdout.read().decode('utf-8', errors='replace').strip()
    if o: print(o[:2000])
    return o

print("=== Home dir ===")
run("ls -la /home/admin/")

print("\n=== Find google-analysis ===")
run("find /home/admin -maxdepth 3 -name 'main.py' -path '*/backend/*' 2>/dev/null")

print("\n=== Find uvicorn process ===")
run("ps aux | grep uvicorn | grep -v grep")

print("\n=== Find article_gen.py ===")
run("find / -name 'article_gen.py' -path '*/api/*' 2>/dev/null | head -5")

ssh.close()
