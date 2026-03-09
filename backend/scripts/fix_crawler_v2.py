import paramiko
import time

HOST = '47.239.193.33'
USER = 'admin'
PASS = 'A123456'
BACKEND = '/home/admin/Google-Data-Analysis/backend'

def upload(local, remote):
    print(f'[Upload] {local} -> {remote}')
    ssh = paramiko.SSHClient()
    ssh.set_missing_host_key_policy(paramiko.AutoAddPolicy())
    ssh.connect(HOST, 22, USER, PASS, timeout=30, banner_timeout=60, allow_agent=False, look_for_keys=False)
    sftp = ssh.open_sftp()
    sftp.put(local, remote)
    sftp.close()
    ssh.close()

def run(desc, cmd):
    print(f'[{desc}]')
    ssh = paramiko.SSHClient()
    ssh.set_missing_host_key_policy(paramiko.AutoAddPolicy())
    ssh.connect(HOST, 22, USER, PASS, timeout=30, banner_timeout=60, allow_agent=False, look_for_keys=False)
    i, o, e = ssh.exec_command(cmd, timeout=60)
    out = o.read().decode(errors='replace').strip()
    err = e.read().decode(errors='replace').strip()
    ssh.close()
    if out: print(out)
    if err and 'WARNING' not in err: print(f'  ERR: {err}')
    return out

upload(r'd:\Google Analysis\backend\app\services\merchant_crawler.py',
       f'{BACKEND}/app/services/merchant_crawler.py')

run('Verify PRESS_SECTION_KEYWORDS exists',
    f"grep -c 'PRESS_SECTION_KEYWORDS\\|is_in_press_section' {BACKEND}/app/services/merchant_crawler.py")

run('Kill', "pkill -f 'uvicorn.*app.main' 2>/dev/null; echo KILLED")
time.sleep(3)
run('Start', f"cd {BACKEND}; nohup {BACKEND}/venv/bin/python3 -m uvicorn app.main:app --host 0.0.0.0 --port 8000 --workers 1 > {BACKEND}/backend.log 2>&1 &")
time.sleep(8)
h = run('Health', 'curl -s -m 10 http://localhost:8000/health')
print('OK!' if h and 'ok' in h.lower() else 'Check logs')
