"""重启后端服务器并验证 OPT-014 部署"""
import paramiko
import time

ssh = paramiko.SSHClient()
ssh.set_missing_host_key_policy(paramiko.AutoAddPolicy())
print("Connecting...", flush=True)
ssh.connect("47.239.193.33", port=22, username="admin", password="A123456", timeout=30)

print("Killing old uvicorn...", flush=True)
stdin, stdout, stderr = ssh.exec_command('pkill -f "uvicorn.*app.main" || true')
stdout.channel.recv_exit_status()
time.sleep(3)

print("Starting new uvicorn...", flush=True)
cmd = (
    "cd /home/admin/Google-Data-Analysis/backend && "
    "nohup ./venv/bin/python -m uvicorn app.main:app "
    "--host 0.0.0.0 --port 8000 --workers 1 "
    "> /home/admin/backend.log 2>&1 &"
)
ssh.exec_command(cmd)
print("  Background start command sent.", flush=True)

print("Waiting 10 seconds...", flush=True)
time.sleep(10)

print("Checking process...")
stdin, stdout, stderr = ssh.exec_command("ps aux | grep uvicorn | grep -v grep")
procs = stdout.read().decode().strip()
if procs:
    print("  uvicorn process: RUNNING")
else:
    print("  WARNING: uvicorn process NOT found!")

print("Health check...")
stdin, stdout, stderr = ssh.exec_command(
    'curl -s -o /dev/null -w "%{http_code}" http://localhost:8000/health'
)
status = stdout.read().decode().strip()
print(f"  Status: {status}")

if status == "200":
    print("\n=== OPT-014 deployed successfully! ===")
else:
    print(f"\nHealth check returned {status}, checking logs...")
    stdin, stdout, stderr = ssh.exec_command("tail -40 /home/admin/backend.log")
    print(stdout.read().decode())

ssh.close()
