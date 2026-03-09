"""重启后端服务 - 使用 venv 完整路径避免 source 问题"""
import paramiko
import time

ssh = paramiko.SSHClient()
ssh.set_missing_host_key_policy(paramiko.AutoAddPolicy())
ssh.connect("47.239.193.33", 22, "admin", "A123456", timeout=15)

# Kill existing
stdin, stdout, stderr = ssh.exec_command("pkill -f 'uvicorn.*app.main' || true")
stdout.channel.recv_exit_status()
time.sleep(2)

# Start using full venv path (no source needed)
cmd = (
    "cd /home/admin/Google-Data-Analysis/backend && "
    "nohup ./venv/bin/uvicorn app.main:app "
    "--host 0.0.0.0 --port 8000 --workers 1 "
    "> /tmp/backend.log 2>&1 &"
)
stdin, stdout, stderr = ssh.exec_command(cmd)
stdout.channel.recv_exit_status()
print("[OK] Backend starting...")

time.sleep(8)

# Health check
stdin, stdout, stderr = ssh.exec_command("curl -s http://127.0.0.1:8000/health")
health = stdout.read().decode().strip()
print(f"[Health] {health}")

# Process check
stdin, stdout, stderr = ssh.exec_command("ps aux | grep uvicorn | grep -v grep")
procs = stdout.read().decode().strip()
print(f"[Process] {procs if procs else 'NONE'}")

if not health or "ok" not in health.lower():
    stdin, stdout, stderr = ssh.exec_command("tail -30 /tmp/backend.log")
    print("[Logs]")
    print(stdout.read().decode())

ssh.close()
