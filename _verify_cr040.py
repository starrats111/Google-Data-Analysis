"""verify CR-040 endpoints"""
import paramiko

def run(ssh, cmd, timeout=30):
    print(f"\n>>> {cmd}")
    stdin, stdout, stderr = ssh.exec_command(cmd, timeout=timeout)
    stdout.channel.recv_exit_status()
    out = stdout.read().decode("utf-8", errors="replace")
    err = stderr.read().decode("utf-8", errors="replace")
    if out.strip(): print(out.strip()[-2000:])
    if err.strip(): print(f"[STDERR] {err.strip()[-1000:]}")
    return out

ssh = paramiko.SSHClient()
ssh.set_missing_host_key_policy(paramiko.AutoAddPolicy())
ssh.connect("47.239.193.33", 22, "admin", "A123456", timeout=15)

# test image-cache endpoint (should return 404 for non-existent session)
run(ssh, "curl -s -o /dev/null -w '%{http_code}' http://localhost:8000/api/article-gen/image-cache/test123/test.jpg")

# test that the app is responding to known endpoints
run(ssh, "curl -s -o /dev/null -w '%{http_code}' http://localhost:8000/api/articles")

# check image_cache_service is importable
run(ssh, """cd /home/admin/Google-Data-Analysis/backend && source venv/bin/activate && python3 -c "
from app.services.image_cache_service import image_cache_service
s = image_cache_service.create_session()
print(f'Session created: {s}')
image_cache_service.cleanup_session(s)
print('Session cleaned up')
print('image_cache_service OK')
"
""")

# check db column
run(ssh, """cd /home/admin/Google-Data-Analysis/backend && source venv/bin/activate && python3 -c "
import sqlite3
conn = sqlite3.connect('google_analysis.db')
c = conn.cursor()
c.execute('PRAGMA table_info(pub_articles)')
cols = [r[1] for r in c.fetchall()]
print('image_cache_session' in cols and 'DB column OK' or 'DB column MISSING')
conn.close()
"
""")

# check uploads dir
run(ssh, "ls -la /home/admin/Google-Data-Analysis/backend/uploads/image_cache/")

ssh.close()
print("\nVerification done!")
