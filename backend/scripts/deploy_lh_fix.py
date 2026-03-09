"""部署 LH 商家同步修复到服务器并重启后端"""
import paramiko
import time

SSH_HOST = "47.239.193.33"
SSH_USER = "admin"
SSH_PASS = "A123456"

ssh = paramiko.SSHClient()
ssh.set_missing_host_key_policy(paramiko.AutoAddPolicy())
ssh.connect(SSH_HOST, 22, SSH_USER, SSH_PASS, timeout=15)

# 1. Upload modified file
local_path = r"d:\Google Analysis\backend\app\services\merchant_platform_sync.py"
remote_path = "/home/admin/Google-Data-Analysis/backend/app/services/merchant_platform_sync.py"

sftp = ssh.open_sftp()
sftp.put(local_path, remote_path)
sftp.close()
print("[OK] File uploaded")

# 2. Restart backend
cmd_kill = "pkill -f 'uvicorn.*app.main' || true"
stdin, stdout, stderr = ssh.exec_command(cmd_kill)
stdout.channel.recv_exit_status()
print("[OK] Old process killed")
time.sleep(3)

cmd_start = (
    "cd /home/admin/Google-Data-Analysis/backend && "
    "source venv/bin/activate && "
    "nohup uvicorn app.main:app --host 0.0.0.0 --port 8000 --workers 1 "
    "> /tmp/backend.log 2>&1 &"
)
stdin, stdout, stderr = ssh.exec_command(cmd_start)
stdout.channel.recv_exit_status()
print("[OK] Backend starting...")
time.sleep(6)

# 3. Health check
stdin, stdout, stderr = ssh.exec_command("curl -s http://127.0.0.1:8000/health")
health = stdout.read().decode().strip()
print(f"[Health] {health}")

# 4. Check startup logs for errors
stdin, stdout, stderr = ssh.exec_command("tail -20 /tmp/backend.log")
logs = stdout.read().decode().strip()
print(f"\n[Startup logs]\n{logs}")

ssh.close()
print("\n[DONE] Deployment complete")
