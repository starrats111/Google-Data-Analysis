import paramiko
import time
import os

HOST = '47.239.193.33'
USER = 'admin'
PASS = 'A123456'
BACKEND = '/home/admin/Google-Data-Analysis/backend'

def upload_and_run(local_path, remote_path, desc):
    print(f'[Upload] {desc}')
    ssh = paramiko.SSHClient()
    ssh.set_missing_host_key_policy(paramiko.AutoAddPolicy())
    ssh.connect(HOST, 22, USER, PASS, timeout=30, banner_timeout=60, allow_agent=False, look_for_keys=False)
    sftp = ssh.open_sftp()
    sftp.put(local_path, remote_path)
    sftp.close()
    ssh.close()
    print(f'  Uploaded {os.path.basename(local_path)}')

def run(desc, cmd, timeout=60):
    print(f'[{desc}]')
    ssh = paramiko.SSHClient()
    ssh.set_missing_host_key_policy(paramiko.AutoAddPolicy())
    ssh.connect(HOST, 22, USER, PASS, timeout=30, banner_timeout=60, allow_agent=False, look_for_keys=False)
    i, o, e = ssh.exec_command(cmd, timeout=timeout)
    out = o.read().decode(errors='replace').strip()
    err = e.read().decode(errors='replace').strip()
    ssh.close()
    if out: print(out)
    if err and any(w in err.lower() for w in ['error', 'fatal']): print(f'ERR: {err[:300]}')
    return out

# Upload fixed articles.py
upload_and_run(
    r'd:\Google Analysis\backend\app\api\articles.py',
    f'{BACKEND}/app/api/articles.py',
    'articles.py (publish_date Z fix)')

# Restart backend
run('Kill backend', "pkill -f 'uvicorn.*app.main' 2>/dev/null; echo KILLED")
time.sleep(3)
run('Start backend',
    f"cd {BACKEND}; nohup {BACKEND}/venv/bin/python3 -m uvicorn app.main:app "
    f"--host 0.0.0.0 --port 8000 --workers 1 > {BACKEND}/backend.log 2>&1 &")
time.sleep(10)
h = run('Health', 'curl -s -m 10 http://localhost:8000/health')
print('DONE!' if h and 'ok' in h.lower() else 'Check logs')
