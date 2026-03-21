"""Check admin user in the database"""
import paramiko
import sys

HOST = "47.239.193.33"
PORT = 22
USER = "admin"
PASS = "A123456"

client = paramiko.SSHClient()
client.set_missing_host_key_policy(paramiko.AutoAddPolicy())
client.connect(HOST, PORT, USER, PASS, timeout=10)

cmd = """sudo mariadb google-data-analysis -e "SELECT id, username, LEFT(password_hash, 30) as pw_prefix, role, status FROM users WHERE role='admin';" """

stdin, stdout, stderr = client.exec_command(cmd, timeout=15)
out = stdout.read().decode("utf-8", errors="replace")
err = stderr.read().decode("utf-8", errors="replace")
if out:
    sys.stdout.buffer.write(out.encode("utf-8", errors="replace"))
    sys.stdout.buffer.flush()
if err:
    sys.stdout.buffer.write(f"[STDERR] {err}\n".encode("utf-8", errors="replace"))
    sys.stdout.buffer.flush()

# Also check if username is case-sensitive
cmd2 = """sudo mariadb google-data-analysis -e "SELECT id, username, role FROM users WHERE LOWER(username) LIKE '%admin%';" """
stdin, stdout, stderr = client.exec_command(cmd2, timeout=15)
out = stdout.read().decode("utf-8", errors="replace")
if out:
    sys.stdout.buffer.write(b"\n--- Users matching 'admin' ---\n")
    sys.stdout.buffer.write(out.encode("utf-8", errors="replace"))
    sys.stdout.buffer.flush()

client.close()
