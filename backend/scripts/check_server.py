import paramiko, time

ssh = paramiko.SSHClient()
ssh.set_missing_host_key_policy(paramiko.AutoAddPolicy())
ssh.connect('47.239.193.33', 22, 'admin', 'A123456', timeout=15)

# Check process
i, o, e = ssh.exec_command('ps aux | grep uvicorn | grep -v grep')
procs = o.read().decode()
print(f'Uvicorn processes:\n{procs}')

if not procs.strip():
    print('No uvicorn running. Trying to start and capture error...')
    # Try to start and capture error
    cmd = 'cd /home/admin/Google-Data-Analysis/backend && source venv/bin/activate && timeout 10 uvicorn app.main:app --host 0.0.0.0 --port 8000 --workers 1 2>&1 || true'
    i, o, e = ssh.exec_command(cmd, timeout=20)
    out = o.read().decode()
    err = e.read().decode()
    print(f'STDOUT:\n{out}')
    print(f'STDERR:\n{err}')
else:
    # Health check
    i, o, e = ssh.exec_command('curl -s http://127.0.0.1:8000/health')
    print(f'Health: {o.read().decode()}')

ssh.close()
