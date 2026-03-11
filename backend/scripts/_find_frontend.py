"""Deploy frontend build to backend server"""
import paramiko, sys, os
sys.stdout.reconfigure(encoding='utf-8')

BE_HOST = '47.239.193.33'
BE_USER = 'admin'
BE_PASS = 'A123456'

ssh = paramiko.SSHClient()
ssh.set_missing_host_key_policy(paramiko.AutoAddPolicy())
ssh.connect(BE_HOST, username=BE_USER, password=BE_PASS, timeout=30)

def run(cmd, timeout=15):
    _, o, e = ssh.exec_command(cmd, timeout=timeout)
    out = o.read().decode('utf-8', errors='replace').strip()
    err = e.read().decode('utf-8', errors='replace').strip()
    if out: print(out[:2000])
    if err and 'warning' not in err.lower(): print(f'ERR: {err[:500]}')
    return out

# Find where frontend is served from
print("=== Finding frontend location ===")
run("find /home/admin -name 'index.html' -path '*/dist/*' 2>/dev/null | head -5")
run("ls /home/admin/Google-Data-Analysis/frontend/dist/ 2>/dev/null | head -5")
run("ls /home/admin/Google-Data-Analysis/dist/ 2>/dev/null | head -5")

# Check nginx config for frontend
print("\n=== Nginx frontend config ===")
run("grep -r 'root.*dist\\|root.*frontend\\|root.*build' /etc/nginx/ 2>/dev/null | head -5")

ssh.close()
