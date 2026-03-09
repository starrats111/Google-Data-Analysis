import paramiko, time

ssh = paramiko.SSHClient()
ssh.set_missing_host_key_policy(paramiko.AutoAddPolicy())
ssh.connect('47.239.193.33', 22, 'admin', 'A123456', timeout=15)

# 1. Start backend with nohup
print('Starting backend...')
cmd = 'cd /home/admin/Google-Data-Analysis/backend && source venv/bin/activate && nohup uvicorn app.main:app --host 0.0.0.0 --port 8000 --workers 1 > /tmp/backend.log 2>&1 &'
i, o, e = ssh.exec_command(cmd)
o.channel.recv_exit_status()
print('Backend started')

time.sleep(8)

# 2. Health check
i, o, e = ssh.exec_command('curl -s http://127.0.0.1:8000/health')
health = o.read().decode()
print(f'Health: {health}')

if not health.strip():
    i, o, e = ssh.exec_command('tail -5 /tmp/backend.log')
    print(f'Log: {o.read().decode()}')

# 3. Run fix script
print('\n' + '='*70)
print('Running LH MID fix script...')
print('='*70)
fix_cmd = 'cd /home/admin/Google-Data-Analysis/backend && source venv/bin/activate && python scripts/fix_lh_mid_full.py 2>&1'
i, o, e = ssh.exec_command(fix_cmd, timeout=300)
output = o.read().decode()
print(output)

ssh.close()
print('Done')
