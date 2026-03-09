import paramiko, time

ssh = paramiko.SSHClient()
ssh.set_missing_host_key_policy(paramiko.AutoAddPolicy())
ssh.connect('47.239.193.33', port=22, username='admin', password='A123456', timeout=15)

# 1. Upload files
sftp = ssh.open_sftp()
sftp.put(r'd:\Google Analysis\backend\app\main.py', '/home/admin/Google-Data-Analysis/backend/app/main.py')
print('main.py uploaded')
sftp.put(r'd:\Google Analysis\backend\scripts\fix_lh_mid_full.py', '/home/admin/Google-Data-Analysis/backend/scripts/fix_lh_mid_full.py')
print('fix_lh_mid_full.py uploaded')
sftp.close()

# 2. Restart backend
restart_cmd = 'cd /home/admin/Google-Data-Analysis/backend && source venv/bin/activate && pkill -f "uvicorn.*app.main" || true && sleep 2 && nohup uvicorn app.main:app --host 0.0.0.0 --port 8000 --workers 1 > /tmp/backend.log 2>&1 &'
stdin, stdout, stderr = ssh.exec_command(restart_cmd)
stdout.channel.recv_exit_status()
print('Backend restarting...')

time.sleep(6)

# 3. Health check
stdin, stdout, stderr = ssh.exec_command('curl -s http://127.0.0.1:8000/health')
health = stdout.read().decode()
print(f'Health: {health}')

if 'ok' not in health.lower() and 'healthy' not in health.lower():
    stdin, stdout, stderr = ssh.exec_command('tail -20 /tmp/backend.log')
    print('Backend log:')
    print(stdout.read().decode())

ssh.close()
print('Deploy done')
