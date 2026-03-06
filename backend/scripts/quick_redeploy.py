import paramiko, time

HOST='47.239.193.33'; USER='admin'; PASS='A123456'
BACKEND='/home/admin/Google-Data-Analysis/backend'

def run(desc, cmd):
    print(f'[{desc}]')
    ssh = paramiko.SSHClient()
    ssh.set_missing_host_key_policy(paramiko.AutoAddPolicy())
    ssh.connect(HOST, 22, USER, PASS, timeout=30, banner_timeout=60, allow_agent=False, look_for_keys=False)
    i,o,e = ssh.exec_command(cmd, timeout=60)
    out = o.read().decode(errors='replace').strip()
    ssh.close()
    if out: print(out)
    return out

run('Git pull', 'cd /home/admin/Google-Data-Analysis && git pull origin main 2>&1 | tail -10')
run('Kill backend', "pkill -f 'uvicorn.*app.main' 2>/dev/null; echo KILLED")
time.sleep(3)
run('Start backend',
    f"cd {BACKEND}; nohup {BACKEND}/venv/bin/python3 -m uvicorn app.main:app "
    f"--host 0.0.0.0 --port 8000 --workers 1 > {BACKEND}/backend.log 2>&1 &")
time.sleep(10)
h = run('Health', 'curl -s -m 10 http://localhost:8000/health')
print('DONE!' if h and 'ok' in h.lower() else 'Check logs')
