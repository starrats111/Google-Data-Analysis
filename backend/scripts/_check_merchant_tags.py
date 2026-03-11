import paramiko, sys
sys.stdout.reconfigure(encoding='utf-8')

ssh = paramiko.SSHClient()
ssh.set_missing_host_key_policy(paramiko.AutoAddPolicy())
ssh.connect("47.239.193.33", username="admin", password="A123456", timeout=10)

def run(cmd, timeout=15):
    stdin, stdout, stderr = ssh.exec_command(cmd, timeout=timeout)
    return stdout.read().decode('utf-8', errors='replace'), stderr.read().decode('utf-8', errors='replace')

# 1. Check if violation/recommendation columns exist in DB
print("=== DB Schema Check ===", flush=True)
out, _ = run("cd /home/admin/Google-Data-Analysis/backend && source venv/bin/activate && python3 -c \""
    "from app.database import SessionLocal; from sqlalchemy import text; "
    "db = SessionLocal(); "
    "rows = db.execute(text('PRAGMA table_info(affiliate_merchants)')).fetchall(); "
    "[print(f'  {r[1]} ({r[2]})') for r in rows if 'violation' in r[1] or 'recommendation' in r[1]]; "
    "db.close()\" 2>&1")
print(out, flush=True)

# 2. Check if any merchants are tagged
print("=== Tagged Merchants ===", flush=True)
out, _ = run("cd /home/admin/Google-Data-Analysis/backend && source venv/bin/activate && python3 -c \""
    "from app.database import SessionLocal; from sqlalchemy import text; "
    "db = SessionLocal(); "
    "violated = db.execute(text(\\\"SELECT COUNT(*) FROM affiliate_merchants WHERE violation_status = 'violated'\\\")).scalar(); "
    "recommended = db.execute(text(\\\"SELECT COUNT(*) FROM affiliate_merchants WHERE recommendation_status = 'recommended'\\\")).scalar(); "
    "total = db.execute(text('SELECT COUNT(*) FROM affiliate_merchants')).scalar(); "
    "print(f'Total: {total}, Violated: {violated}, Recommended: {recommended}'); "
    "db.close()\" 2>&1")
print(out, flush=True)

# 3. Test API endpoint
print("=== API Test ===", flush=True)
out, _ = run("curl -s 'http://localhost:8000/api/merchants?page=1&page_size=2' -H 'Authorization: Bearer test' 2>&1 | head -5")
print(out[:500], flush=True)

ssh.close()
