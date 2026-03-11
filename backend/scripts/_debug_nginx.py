"""Debug nginx startup issue"""
import paramiko, glob

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

# Check nginx status
run("sudo systemctl status nginx 2>&1")
run("sudo journalctl -xeu nginx.service --no-pager -n 30 2>&1")

# Check if nginx is running via process
run("ps aux | grep nginx")

# Check what's on port 80
run("sudo ss -tlnp | grep ':80\\|:443'")

# Try starting nginx directly
run("sudo nginx 2>&1")
run("ps aux | grep nginx")

ssh.close()
