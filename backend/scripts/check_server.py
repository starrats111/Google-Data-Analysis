import paramiko
import time

ssh = paramiko.SSHClient()
ssh.set_missing_host_key_policy(paramiko.AutoAddPolicy())
ssh.connect('47.239.193.33', port=22, username='admin', password='A123456', timeout=15)

# 检查目录和venv
cmds = [
    'ls -la /home/admin/Google-Data-Analysis/backend/',
    'ls -la /home/admin/Google-Data-Analysis/backend/venv/bin/python*',
    'cat /home/admin/backend.log | tail -30',
    'which python3',
    'cat /home/admin/Google-Data-Analysis/backend/venv/bin/activate | head -5',
]

for cmd in cmds:
    print(f'=== {cmd} ===')
    stdin, stdout, stderr = ssh.exec_command(cmd, timeout=10)
    out = stdout.read().decode()
    err = stderr.read().decode()
    if out.strip():
        print(out)
    if err.strip():
        print('STDERR:', err)
    print()

ssh.close()
