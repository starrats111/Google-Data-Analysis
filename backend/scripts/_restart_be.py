"""Restart backend after deploy"""
import paramiko, time, sys
sys.stdout.reconfigure(encoding='utf-8')
be = paramiko.SSHClient()
be.set_missing_host_key_policy(paramiko.AutoAddPolicy())
be.connect("47.239.193.33", 22, "admin", password="A123456", timeout=15)
def run_be(cmd, t=30):
    stdin, stdout, stderr = be.exec_command(cmd, timeout=t)
    stdout.channel.recv_exit_status()
    return stdout.read().decode('utf-8', errors='replace').strip()

proj = "/home/admin/Google-Data-Analysis"

# Check if build succeeded
print("=== Check build output ===")
print(run_be(f"ls -la {proj}/frontend/dist/index.html 2>/dev/null || echo 'No dist'"))
print(run_be(f"ls -la {proj}/frontend/dist/ 2>/dev/null | tail -5"))

# Restart backend (fire-and-forget)
print("\n=== Restart Backend ===")
restart_cmd = f"cd {proj}/backend && pkill -f 'uvicorn app.main:app' 2>/dev/null; sleep 1; nohup /home/admin/.local/bin/uvicorn app.main:app --host 0.0.0.0 --port 8000 > /tmp/backend.log 2>&1 &"
run_be(f"bash -c '{restart_cmd}'", t=10)
print("Backend restart command sent")

time.sleep(4)

# Health check
print("\n=== Health Check ===")
be2 = paramiko.SSHClient()
be2.set_missing_host_key_policy(paramiko.AutoAddPolicy())
be2.connect("47.239.193.33", 22, "admin", password="A123456", timeout=15)
stdin, stdout, stderr = be2.exec_command("curl -s -o /dev/null -w '%{http_code}' http://localhost:8000/api/health", timeout=10)
stdout.channel.recv_exit_status()
code = stdout.read().decode().strip()
print(f"Health: {code}")

if code != '200':
    time.sleep(3)
    stdin, stdout, stderr = be2.exec_command("curl -s -o /dev/null -w '%{http_code}' http://localhost:8000/api/health", timeout=10)
    stdout.channel.recv_exit_status()
    code = stdout.read().decode().strip()
    print(f"Health retry: {code}")

be2.close()
be.close()
print("\n✅ Done!")
