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

run("Uvicorn process", "ps aux | grep uvicorn | grep -v grep")
run("Port 8000", "ss -tlnp | grep 8000")
run("Backend log (last 30)", "tail -30 /home/admin/backend.log")
run("Health check", "curl -s -m 5 http://localhost:8000/health 2>&1")
