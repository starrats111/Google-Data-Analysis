"""Deploy updated remote_publisher.py + articles.py to backend server and restart"""
import paramiko, sys, os, time
sys.stdout.reconfigure(encoding='utf-8')

ssh = paramiko.SSHClient()
ssh.set_missing_host_key_policy(paramiko.AutoAddPolicy())
ssh.connect('47.239.193.33', 22, 'admin', password='A123456', timeout=15)

BACKEND = "/home/admin/Google-Data-Analysis/backend"

# Upload files
sftp = ssh.open_sftp()

files_to_upload = [
    ("remote_publisher.py", "app/services/remote_publisher.py"),
    ("articles.py", "app/api/articles.py"),
]

for local_name, remote_rel in files_to_upload:
    local_path = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", remote_rel))
    remote_path = f"{BACKEND}/{remote_rel}"
    sftp.put(local_path, remote_path)
    print(f"Uploaded: {remote_rel}")

sftp.close()

# Restart backend
print("\nRestarting backend...")
ssh.exec_command("pkill -f 'uvicorn app.main' || true")
time.sleep(2)
ssh.exec_command(f"cd {BACKEND} && source venv/bin/activate && nohup python -m uvicorn app.main:app --host 0.0.0.0 --port 8000 --workers 2 > /home/admin/backend.log 2>&1 &")
time.sleep(6)

# Verify
stdin, stdout, stderr = ssh.exec_command("ps aux | grep uvicorn | grep -v grep", timeout=10)
stdout.channel.recv_exit_status()
out = stdout.read().decode('utf-8', errors='replace').strip()
print(f"Uvicorn: {'RUNNING' if out else 'NOT RUNNING'}")

stdin, stdout, stderr = ssh.exec_command('curl -s -o /dev/null -w "%{http_code}" http://localhost:8000/health', timeout=10)
stdout.channel.recv_exit_status()
health = stdout.read().decode('utf-8', errors='replace').strip()
print(f"Health: {health}")

ssh.close()
print("Done!")
