"""Upload and execute remaining migration steps 10-12 on server"""
import paramiko

HOST = "47.239.193.33"
PORT = 22
USER = "admin"
PASS = "A123456"

client = paramiko.SSHClient()
client.set_missing_host_key_policy(paramiko.AutoAddPolicy())
client.connect(HOST, PORT, USER, PASS, timeout=10)

print("Uploading remaining migration script...")
sftp = client.open_sftp()
sftp.put(
    r"d:\Program Files (x86)\wz\Google Analysis\_migrate_remaining.py",
    "/home/admin/Google-Data-Analysis/_migrate_remaining.py"
)
sftp.close()
print("Upload complete.")

print("Running remaining migration steps 10-12...")
stdin, stdout, stderr = client.exec_command(
    "cd ~/Google-Data-Analysis && python3 _migrate_remaining.py 2>&1",
    timeout=120
)
stdout.channel.settimeout(120)
print(stdout.read().decode())
err = stderr.read().decode()
if err:
    print(f"[STDERR] {err}")

client.close()
