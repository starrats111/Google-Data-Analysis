import paramiko

HOST = '47.239.193.33'
USER = 'admin'
PASS = 'A123456'

def run(desc, cmd):
    print(f"\n[{desc}]")
    ssh = paramiko.SSHClient()
    ssh.set_missing_host_key_policy(paramiko.AutoAddPolicy())
    ssh.connect(HOST, port=22, username=USER, password=PASS, timeout=15)
    stdin, stdout, stderr = ssh.exec_command(cmd, timeout=30)
    out = stdout.read().decode().strip()
    err = stderr.read().decode().strip()
    if out: print(out)
    if err: print(f"ERR: {err}")
    ssh.close()
    return out

run("Backend nohup log (last 50)", "tail -50 /home/admin/nohup.out 2>/dev/null || echo 'no nohup.out'")
run("Backend log2 (last 50)", "tail -50 /home/admin/Google-Data-Analysis/backend/backend.log 2>/dev/null || echo 'no file'")
run("curl verbose", "curl -v -m 10 http://localhost:8000/health 2>&1")
run("nginx config", "cat /etc/nginx/sites-enabled/default 2>/dev/null || cat /etc/nginx/nginx.conf 2>/dev/null || echo 'nginx config not found'")
