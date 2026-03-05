"""OPT-011 部署验证"""
import paramiko

HOST = '47.239.193.33'
USER = 'admin'
PASS = 'A123456'

def run(desc, cmd):
    print(f"\n[{desc}]")
    ssh = paramiko.SSHClient()
    ssh.set_missing_host_key_policy(paramiko.AutoAddPolicy())
    ssh.connect(HOST, port=22, username=USER, password=PASS, timeout=15)
    stdin, stdout, stderr = ssh.exec_command(cmd, timeout=30)
    out = stdout.read().decode().strip()
    err = stderr.read().decode().strip()
    if out:
        print(out)
    if err:
        print(f"ERR: {err}")
    ssh.close()
    return out

# Check if uvicorn is running
run("Uvicorn process", "ps aux | grep uvicorn | grep -v grep")

# Health check
out = run("Health check", "curl -s http://localhost:8000/health")

# Check new API endpoints
run("Articles API", "curl -s -o /dev/null -w '%{http_code}' http://localhost:8000/api/article-categories")
run("Tags API", "curl -s -o /dev/null -w '%{http_code}' http://localhost:8000/api/article-tags")

# Check tables exist
run("Check pub_* tables", """cd /home/admin/Google-Data-Analysis/backend && source venv/bin/activate && python -c "
from app.database import engine
from sqlalchemy import inspect
tables = inspect(engine).get_table_names()
pub_tables = [t for t in tables if t.startswith('pub_')]
print(f'Found {len(pub_tables)} pub_* tables: {pub_tables}')
" """)

# Check startup log
run("Backend log (last 10 lines)", "tail -10 /home/admin/backend.log")

print("\n" + "=" * 50)
print("Verification complete!")
