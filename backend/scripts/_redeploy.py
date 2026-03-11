"""Full redeploy: git pull + restart backend"""
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

# 1. Git pull
print("=== Git Pull ===")
print(run(f"cd {proj} && git pull"))

# 2. Verify files updated
print("\n=== Verify remote_publisher.py has _check_image_quality ===")
print(run(f"grep -c '_check_image_quality' {proj}/backend/app/services/remote_publisher.py"))

print("\n=== Verify merchant_crawler.py has _search_images_single ===")
print(run(f"grep -c '_search_images_single' {proj}/backend/app/services/merchant_crawler.py"))

# 3. Start backend
print("\n=== Start Backend ===")
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

# 4. Health check
print("\n=== Health Check ===")
print(run("curl -s -m 5 http://localhost:8000/health"))

# 5. Check processes
print("\n=== Processes ===")
print(run("ps aux | grep uvicorn | grep -v grep"))

ssh.close()
print("\n✅ Done!")
