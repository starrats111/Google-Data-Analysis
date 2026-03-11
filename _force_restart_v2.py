import paramiko
import time

ssh = paramiko.SSHClient()
ssh.set_missing_host_key_policy(paramiko.AutoAddPolicy())
ssh.connect('47.239.193.33', port=22, username='admin', password='A123456', timeout=15)

# Find ALL processes on port 8000
print("Finding processes on port 8000...")
stdin, stdout, stderr = ssh.exec_command("ss -tlnp | grep 8000")
ss_out = stdout.read().decode()
print(ss_out)

# Find ALL uvicorn processes (including other users)
stdin, stdout, stderr = ssh.exec_command("ps aux | grep uvicorn | grep -v grep")
ps_out = stdout.read().decode()
print("All uvicorn processes:")
print(ps_out)

# Kill by port - find PID listening on 8000
stdin, stdout, stderr = ssh.exec_command("lsof -ti:8000 2>/dev/null || fuser 8000/tcp 2>/dev/null")
port_pids = stdout.read().decode().strip()
print(f"PIDs on port 8000: '{port_pids}'")

if port_pids:
    # Clean up the PIDs
    pids = [p.strip() for p in port_pids.replace('\n', ' ').split() if p.strip().isdigit()]
    if pids:
        pid_str = ' '.join(pids)
        print(f"Killing PIDs: {pid_str}")
        ssh.exec_command(f'kill -9 {pid_str}')
        time.sleep(3)

# Also try killing all python uvicorn processes
print("Killing all uvicorn processes...")
ssh.exec_command("pkill -9 -f 'uvicorn app.main'")
time.sleep(3)

# Verify port is free
stdin, stdout, stderr = ssh.exec_command("ss -tlnp | grep 8000")
check = stdout.read().decode().strip()
if check:
    print(f"Port 8000 still in use: {check}")
    print("Trying harder...")
    ssh.exec_command("fuser -k 8000/tcp")
    time.sleep(3)
else:
    print("Port 8000 is free!")

# Start fresh
print("\nStarting uvicorn...")
start_cmd = (
    'cd /home/admin/Google-Data-Analysis/backend && '
    'source venv/bin/activate && '
    'nohup python -m uvicorn app.main:app --host 0.0.0.0 --port 8000 --workers 2 '
    '> /home/admin/backend.log 2>&1 &'
)
transport = ssh.get_transport()
channel = transport.open_session()
channel.exec_command(start_cmd)
time.sleep(8)

# Verify
stdin, stdout, stderr = ssh.exec_command('ps aux | grep uvicorn | grep -v grep | head -5')
result = stdout.read().decode()
if 'uvicorn' in result:
    print("uvicorn is RUNNING!")
else:
    print("uvicorn NOT running, checking log...")
    stdin, stdout, stderr = ssh.exec_command('tail -20 /home/admin/backend.log')
    print(stdout.read().decode()[-500:])

# Health check
time.sleep(3)
stdin, stdout, stderr = ssh.exec_command('curl -s -o /dev/null -w "%{http_code}" http://localhost:8000/health')
code = stdout.read().decode().strip()
print(f"\nHealth check: HTTP {code}")

ssh.close()
print("Done!")
