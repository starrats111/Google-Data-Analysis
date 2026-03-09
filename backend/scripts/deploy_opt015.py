"""OPT-015 部署脚本：上传后端文件 + 重启"""
import paramiko
import os
import time

SERVER = "47.239.193.33"
USER = "admin"
PASSWORD = "A123456"
REMOTE_BASE = "/home/admin/Google-Data-Analysis/backend"
LOCAL_BASE = os.path.join(os.path.dirname(__file__), "..")

FILES_TO_UPLOAD = [
    ("app/services/campaign_link_service.py", "app/services/campaign_link_service.py"),
    ("app/api/article_gen.py", "app/api/article_gen.py"),
]

print("[1/3] Connecting and uploading files...", flush=True)
ssh = paramiko.SSHClient()
ssh.set_missing_host_key_policy(paramiko.AutoAddPolicy())
ssh.connect(SERVER, port=22, username=USER, password=PASSWORD, timeout=60, banner_timeout=60)
sftp = ssh.open_sftp()

for local_rel, remote_rel in FILES_TO_UPLOAD:
    local_path = os.path.join(LOCAL_BASE, local_rel)
    remote_path = f"{REMOTE_BASE}/{remote_rel}"
    print(f"  {local_rel} -> {remote_path}", flush=True)
    sftp.put(local_path, remote_path)
sftp.close()
print("  Upload complete.", flush=True)

print("[2/3] Restarting backend...", flush=True)
ssh.exec_command('pkill -f "uvicorn.*app.main" || true')
time.sleep(3)

cmd = (
    f"cd {REMOTE_BASE} && "
    "nohup ./venv/bin/python -m uvicorn app.main:app "
    "--host 0.0.0.0 --port 8000 --workers 1 "
    "> /home/admin/backend.log 2>&1 &"
)
ssh.exec_command(cmd)
print("  Waiting 10 seconds...", flush=True)
time.sleep(10)

print("[3/3] Verifying...", flush=True)
stdin, stdout, stderr = ssh.exec_command("ps aux | grep uvicorn | grep -v grep")
procs = stdout.read().decode().strip()
if procs:
    print("  uvicorn: RUNNING", flush=True)
else:
    print("  WARNING: uvicorn NOT found!", flush=True)

stdin, stdout, stderr = ssh.exec_command(
    'curl -s -o /dev/null -w "%{http_code}" http://localhost:8000/health'
)
status = stdout.read().decode().strip()
print(f"  Health: {status}", flush=True)

if status == "200":
    print("\n=== OPT-015 backend deployed successfully! ===", flush=True)
else:
    print(f"\n=== WARNING: Health check returned {status} ===", flush=True)
    stdin, stdout, stderr = ssh.exec_command("tail -40 /home/admin/backend.log")
    print(stdout.read().decode(), flush=True)

ssh.close()
