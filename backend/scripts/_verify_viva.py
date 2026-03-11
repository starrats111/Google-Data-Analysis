"""Reload nginx and verify viva-luxe-life.top"""
import paramiko, glob, sys
sys.stdout.reconfigure(encoding='utf-8')

pem = glob.glob(r'C:\Users\Administrator\Desktop\**\awssg0306.pem', recursive=True)[0]
ssh = paramiko.SSHClient()
ssh.set_missing_host_key_policy(paramiko.AutoAddPolicy())
pkey = paramiko.RSAKey.from_private_key_file(pem)
ssh.connect('52.74.221.116', username='ubuntu', pkey=pkey, timeout=30)

def run(cmd):
    print(f">>> {cmd}")
    stdin, stdout, stderr = ssh.exec_command(cmd, timeout=30)
    o = stdout.read().decode('utf-8', errors='replace').strip()
    e = stderr.read().decode('utf-8', errors='replace').strip()
    if o: print(o[:2000])
    if e: print(f'STDERR: {e[:1000]}')
    return o

# Nginx is already running, just reload
run("sudo nginx -s reload 2>&1")

# Verify
run('curl -s -o /dev/null -w "%{http_code}" http://localhost -H "Host: viva-luxe-life.top"')
run('curl -s -o /dev/null -w "%{http_code}" https://localhost -k -H "Host: viva-luxe-life.top"')

# Check site structure one more time
print("\n=== Site structure check ===")
run("ls -la /www/wwwroot/viva-luxe-life.top/")
run("ls -la /www/wwwroot/viva-luxe-life.top/js/")
run("ls -la /www/wwwroot/viva-luxe-life.top/css/")
run("ls -la /www/wwwroot/viva-luxe-life.top/articles/")

# Check article structure - important for remote_publisher compatibility
print("\n=== Article structure check ===")
run("head -30 /www/wwwroot/viva-luxe-life.top/articles/article1.html")

# Check main.js for article loading pattern
print("\n=== main.js article loading pattern ===")
run("grep -n 'article\\|Article\\|data\\|json\\|fetch' /www/wwwroot/viva-luxe-life.top/js/main.js | head -30")

ssh.close()
print("\nDone!")
