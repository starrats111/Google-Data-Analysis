"""Fix git conflict and redeploy"""
import paramiko, time, sys
sys.stdout.reconfigure(encoding='utf-8')
ssh = paramiko.SSHClient()
ssh.set_missing_host_key_policy(paramiko.AutoAddPolicy())
ssh.connect('47.239.193.33', port=22, username='admin', password='A123456', timeout=20)
def run(cmd, t=60):
    stdin, stdout, stderr = ssh.exec_command(cmd, timeout=t)
    stdout.channel.recv_exit_status()
    out = stdout.read().decode('utf-8', errors='replace').strip()
    err = stderr.read().decode('utf-8', errors='replace').strip()
    return out + ("\nSTDERR: " + err if err else "")

proj = "/home/admin/Google-Data-Analysis"

# 1. Stash local changes and pull
print("=== Git stash + pull ===")
print(run(f"cd {proj} && git stash && git pull"))

# 2. Verify
print("\n=== Verify _check_image_quality ===")
print(run(f"grep -c '_check_image_quality' {proj}/backend/app/services/remote_publisher.py"))
print(run(f"grep -c '_search_images_single' {proj}/backend/app/services/merchant_crawler.py"))

# 3. Restart backend
print("\n=== Restart Backend ===")
print(run("pkill -f 'uvicorn app.main:app' 2>/dev/null; echo killed"))
time.sleep(2)

cmd = f"""cd {proj}/backend && source venv/bin/activate && \
nohup python -m uvicorn app.main:app --host 0.0.0.0 --port 8000 --workers 2 \
>> /home/admin/backend.log 2>&1 & disown && echo "Started PID: $!" """
transport = ssh.get_transport()
channel = transport.open_session()
channel.exec_command(cmd)
time.sleep(5)
if channel.recv_ready():
    print(channel.recv(4096).decode())
channel.close()

print("等待启动...")
time.sleep(10)

# 4. Health
print("\n=== Health ===")
print(run("curl -s -m 5 http://localhost:8000/health"))

ssh.close()
print("\n✅ Done!")
