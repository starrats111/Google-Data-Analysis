"""OPT-014 部署脚本：上传修改文件 + 重启后端"""
import paramiko
import time
import os

SERVER = "47.239.193.33"
USER = "admin"
PASSWORD = "A123456"
REMOTE_BASE = "/home/admin/Google-Data-Analysis/backend"

FILES_TO_UPLOAD = [
    ("app/models/merchant.py", "app/models/merchant.py"),
    ("app/services/merchant_platform_sync.py", "app/services/merchant_platform_sync.py"),
    ("app/services/scheduler.py", "app/services/scheduler.py"),
    ("app/main.py", "app/main.py"),
]

LOCAL_BASE = os.path.join(os.path.dirname(__file__), "..")

ssh = paramiko.SSHClient()
ssh.set_missing_host_key_policy(paramiko.AutoAddPolicy())
print(f"[1/4] Connecting to {SERVER}...")
ssh.connect(SERVER, port=22, username=USER, password=PASSWORD, timeout=15)
sftp = ssh.open_sftp()

print("[2/4] Uploading modified files...")
for local_rel, remote_rel in FILES_TO_UPLOAD:
    local_path = os.path.join(LOCAL_BASE, local_rel)
    remote_path = f"{REMOTE_BASE}/{remote_rel}"
    print(f"  {local_rel} -> {remote_path}")
    sftp.put(local_path, remote_path)
sftp.close()
print("  Upload complete.")

print("[3/4] Restarting backend...")
restart_cmds = [
    "pkill -f 'uvicorn.*app.main' || true",
    "sleep 2",
    f"cd {REMOTE_BASE} && nohup ./venv/bin/python -m uvicorn app.main:app --host 0.0.0.0 --port 8000 --workers 1 > /home/admin/backend.log 2>&1 & echo STARTED",
]
for cmd in restart_cmds:
    stdin, stdout, stderr = ssh.exec_command(cmd)
    out = stdout.read().decode().strip()
    err = stderr.read().decode().strip()
    if out:
        print(f"  stdout: {out}")
    if err:
        print(f"  stderr: {err}")

print("  Waiting 8 seconds for backend to start...")
time.sleep(8)

print("[4/4] Verifying deployment...")
stdin, stdout, stderr = ssh.exec_command("ps aux | grep uvicorn | grep -v grep")
procs = stdout.read().decode().strip()
if procs:
    print(f"  uvicorn process found: OK")
else:
    print("  WARNING: uvicorn process NOT found!")

stdin, stdout, stderr = ssh.exec_command('curl -s -o /dev/null -w "%{http_code}" http://localhost:8000/health')
status = stdout.read().decode().strip()
print(f"  Health check status: {status}")

if status == "200":
    print("\n=== OPT-014 deployment SUCCESS ===")
else:
    print(f"\n=== WARNING: Health check returned {status}, checking logs... ===")
    stdin, stdout, stderr = ssh.exec_command("tail -30 /home/admin/backend.log")
    print(stdout.read().decode())

ssh.close()
