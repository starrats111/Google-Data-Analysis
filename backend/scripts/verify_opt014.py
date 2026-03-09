"""验证 OPT-014 部署：上传验证脚本并执行"""
import paramiko
import time

ssh = paramiko.SSHClient()
ssh.set_missing_host_key_policy(paramiko.AutoAddPolicy())
ssh.connect("47.239.193.33", port=22, username="admin", password="A123456", timeout=30)

verify_code = '''import sqlite3
conn = sqlite3.connect("/home/admin/Google-Data-Analysis/backend/google_analysis.db")
cursor = conn.cursor()
cursor.execute("PRAGMA table_info(affiliate_merchants)")
columns = [row[1] for row in cursor.fetchall()]
print("Columns:", columns)
has_last_seen = "last_seen_at" in columns
has_misses = "consecutive_misses" in columns
print("last_seen_at present:", has_last_seen)
print("consecutive_misses present:", has_misses)
if has_last_seen and has_misses:
    print("OPT-014 DB migration: OK")
else:
    print("OPT-014 DB migration: FAILED")
conn.close()
'''

sftp = ssh.open_sftp()
with sftp.open("/tmp/verify_opt014.py", "w") as f:
    f.write(verify_code)
sftp.close()

stdin, stdout, stderr = ssh.exec_command(
    "cd /home/admin/Google-Data-Analysis/backend && ./venv/bin/python /tmp/verify_opt014.py"
)
print(stdout.read().decode())
err = stderr.read().decode().strip()
if err:
    print("STDERR:", err)

ssh.close()
