import paramiko
import time

HOST = '47.239.193.33'
USER = 'admin'
PASS = 'A123456'
BACKEND = '/home/admin/Google-Data-Analysis/backend'

def run(desc, cmd, timeout=60):
    print(f"\n[{desc}]")
    ssh = paramiko.SSHClient()
    ssh.set_missing_host_key_policy(paramiko.AutoAddPolicy())
    ssh.connect(HOST, 22, USER, PASS, timeout=30, banner_timeout=60,
                allow_agent=False, look_for_keys=False)
    stdin, stdout, stderr = ssh.exec_command(cmd, timeout=timeout)
    out = stdout.read().decode(errors='replace').strip()
    err = stderr.read().decode(errors='replace').strip()
    ssh.close()
    if out:
        print(out)
    if err and any(w in err.lower() for w in ['error', 'fatal', 'fail']):
        print(f"ERR: {err[:300]}")
    return out

run("Start backend",
    f"cd {BACKEND}; "
    f"nohup {BACKEND}/venv/bin/python3 -m uvicorn app.main:app "
    f"--host 0.0.0.0 --port 8000 --workers 1 "
    f"> {BACKEND}/backend.log 2>&1 &")

print("\nWaiting 10s...")
time.sleep(10)

health = run("Health check", "curl -s -m 10 http://localhost:8000/health")
run("Process check", "ps aux | grep uvicorn | grep -v grep")

if health and "ok" in health.lower():
    print("\n=== Backend started successfully! ===")
else:
    print("\n=== WARNING: check output above ===")
