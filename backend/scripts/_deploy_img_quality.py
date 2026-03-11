"""Deploy image quality improvements to backend"""
import paramiko, time, sys
sys.stdout.reconfigure(encoding='utf-8')

ssh = paramiko.SSHClient()
ssh.set_missing_host_key_policy(paramiko.AutoAddPolicy())
ssh.connect('47.239.193.33', port=22, username='admin', password='A123456', timeout=20)
print("✅ SSH connected")

def run(cmd, t=60):
    stdin, stdout, stderr = ssh.exec_command(cmd, timeout=t)
    stdout.channel.recv_exit_status()
    return stdout.read().decode('utf-8', errors='replace').strip()

proj = "/home/admin/Google-Data-Analysis"

# 1. Git pull
print("=== Git Pull ===")
print(run(f"cd {proj} && git pull"))

# 2. Install PIL/numpy/scipy if needed
print("\n=== Check dependencies ===")
print(run(f"cd {proj}/backend && source venv/bin/activate && pip list 2>/dev/null | grep -iE 'Pillow|numpy|scipy'"))

# 3. Install missing deps
print("\n=== Install missing deps ===")
print(run(f"cd {proj}/backend && source venv/bin/activate && pip install Pillow numpy scipy 2>&1 | tail -5", t=120))

# 4. Restart backend
print("\n=== Restart Backend ===")
cmd = f"""pkill -f 'uvicorn app.main:app' 2>/dev/null; sleep 2; \
cd {proj}/backend && source venv/bin/activate && \
nohup python -m uvicorn app.main:app --host 0.0.0.0 --port 8000 --workers 2 \
>> /home/admin/backend.log 2>&1 & disown && echo "PID: $!" """

transport = ssh.get_transport()
channel = transport.open_session()
channel.exec_command(cmd)
time.sleep(4)
if channel.recv_ready():
    print(channel.recv(4096).decode())
channel.close()

print("等待启动...")
time.sleep(8)

# 5. Health check
print(run('curl -s -m 5 http://localhost:8000/health'))

ssh.close()
print("\n✅ Deploy complete!")
