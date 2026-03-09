"""Debug server status"""
import paramiko

ssh = paramiko.SSHClient()
ssh.set_missing_host_key_policy(paramiko.AutoAddPolicy())
ssh.connect("47.239.193.33", 22, "admin", "A123456", timeout=15)

commands = [
    ("Directory", "ls -la /home/admin/Google-Data-Analysis/backend/"),
    ("Venv exists", "ls /home/admin/Google-Data-Analysis/backend/venv/bin/python"),
    ("Python version", "/home/admin/Google-Data-Analysis/backend/venv/bin/python --version"),
    ("Port 8000", "ss -tlnp | grep 8000"),
    ("Disk", "df -h /"),
    ("Memory", "free -m"),
]

for label, cmd in commands:
    stdin, stdout, stderr = ssh.exec_command(cmd)
    out = stdout.read().decode().strip()
    err = stderr.read().decode().strip()
    print(f"\n=== {label} ===")
    if out:
        print(out[:1500])
    if err:
        print(f"STDERR: {err[:500]}")

# Try starting uvicorn in foreground for a few seconds to see errors
print("\n=== Starting uvicorn (foreground test) ===")
cmd = (
    "cd /home/admin/Google-Data-Analysis/backend && "
    "source venv/bin/activate && "
    "timeout 5 uvicorn app.main:app --host 0.0.0.0 --port 8000 --workers 1 2>&1 || true"
)
stdin, stdout, stderr = ssh.exec_command(cmd, timeout=15)
out = stdout.read().decode().strip()
err = stderr.read().decode().strip()
print(out[:3000])
if err:
    print(f"STDERR: {err[:1000]}")

ssh.close()
