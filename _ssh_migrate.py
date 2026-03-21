"""Upload and execute migration script on server"""
import paramiko

HOST = "47.239.193.33"
PORT = 22
USER = "admin"
PASS = "A123456"

client = paramiko.SSHClient()
client.set_missing_host_key_policy(paramiko.AutoAddPolicy())
client.connect(HOST, PORT, USER, PASS, timeout=10)

print("Uploading migration script...")
sftp = client.open_sftp()
sftp.put(
    r"d:\Program Files (x86)\wz\Google Analysis\_migration_script.py",
    "/home/admin/Google-Data-Analysis/_migration_script.py"
)
sftp.close()
print("Upload complete.")

print("Running migration script...")
stdin, stdout, stderr = client.exec_command(
    "cd ~/Google-Data-Analysis && python3 _migration_script.py 2>&1",
    timeout=300
)
stdout.channel.settimeout(300)
print(stdout.read().decode())
err = stderr.read().decode()
if err:
    print(f"[STDERR] {err}")

client.close()
