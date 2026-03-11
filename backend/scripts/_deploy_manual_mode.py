import paramiko
import time
import sys

HOST = '47.239.193.33'
USER = 'admin'
PASS = 'A123456'

def run_cmd(ssh, cmd, timeout=30):
    print(f'[CMD) {cmd}')
    stdin, stdout, stderr = ssh.exec_command(cmd, timeout=timeout)
    out = stdout.read().decode().strip()
    err = stderr.read().decode().strip()
    code = stdout.channel.recv_exit_status()
    if out:
        print(f'[OUT] {out}')
    if err:
        print(f'[ERR] {err}')
    print(f'[EXIT] {code}')
    return out, err, code

def run_cmd_fire_and_forget(ssh, cmd):
    print(f'[CMD-BG] {cmd}')
    transport = ssh.get_transport()
    channel = transport.open_session()
    channel.exec_command(cmd)
    time.sleep(1)
    print('[BG] Command sent.')

def main():
    ssh = paramiko.SSHClient()
    ssh.set_missing_host_key_policy(paramiko.AutoAddPolicy())
    print(f'Connecting to {HOST}...')
    ssh.connect(HOST, username=USER, password=PASS, timeout=15)
    print('Connected.\n')

    # Step 1: git pull (already done but run again to confirm)
    run_cmd(ssh, 'cd /home/admin/Google-Data-Analysis && git pull')

    # Step 2: kill uvicorn
    print()
    run_cmd(ssh, 'pkill -f uvicorn || true; sleep 2; echo uvicorn_killed')

    # Step 3: restart backend (fire and forget)
    print()
    restart_cmd = (
        'cd /home/admin/Google-Data-Analysis/backend && '
        'source venv/bin/activate && '
        'nohup uvicorn app.main:app --host 0.0.0.0 --port 8000 '
        '> /home/admin/backend.log 2>&1 &'
    )
    run_cmd_fire_and_forget(ssh, restart_cmd)

    # Step 4: wait and health check
    print('\nWaiting 5 seconds for startup...')
    time.sleep(5)
    out, err, code = run_cmd(ssh, 'curl -s http://localhost:8000/api/health')

    # Result
    print('\n' + '=' * 50)
    if code == 0 and out:
        print(f'DEPLOY SUCCESS. Health: {out}')
    else:
        print(f'DEPLOY MIGHT HAVE ISSUES. Health check exit={code}')
        print('Checking backend log...')
        run_cmd(ssh, 'tail -20 /home/admin/backend.log')

    ssh.close()

if __name__ == '__main__':
    main()
