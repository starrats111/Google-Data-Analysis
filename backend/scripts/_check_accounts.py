import paramiko, sys
sys.stdout.reconfigure(encoding='utf-8')

ssh = paramiko.SSHClient()
ssh.set_missing_host_key_policy(paramiko.AutoAddPolicy())
ssh.connect("47.239.193.33", username="admin", password="A123456", timeout=10)

sftp = ssh.open_sftp()
with sftp.open("/tmp/check_accounts.py", "w") as f:
    f.write("""
import sys, os
sys.path.insert(0, "/home/admin/Google-Data-Analysis/backend")
os.chdir("/home/admin/Google-Data-Analysis/backend")

from app.database import SessionLocal
from sqlalchemy import text

db = SessionLocal()

# 1. affiliate_platforms schema
print("=== affiliate_platforms schema ===")
rows = db.execute(text("PRAGMA table_info(affiliate_platforms)")).fetchall()
for r in rows:
    print(f"  {r[1]} ({r[2]})")

# 2. All platforms
print()
print("=== Platforms ===")
rows = db.execute(text("SELECT * FROM affiliate_platforms")).fetchall()
for r in rows:
    print(f"  {r}")

# 3. affiliate_accounts schema
print()
print("=== affiliate_accounts schema ===")
rows = db.execute(text("PRAGMA table_info(affiliate_accounts)")).fetchall()
for r in rows:
    print(f"  {r[1]} ({r[2]})")

# 4. Active accounts with platform name
print()
print("=== Active Accounts ===")
rows = db.execute(text(
    "SELECT aa.user_id, u.username, ap.name as platform_name "
    "FROM affiliate_accounts aa "
    "JOIN users u ON u.id = aa.user_id "
    "JOIN affiliate_platforms ap ON ap.id = aa.platform_id "
    "WHERE aa.status = 'active' "
    "ORDER BY aa.user_id, ap.name"
)).fetchall()
current_uid = None
for r in rows:
    if r[0] != current_uid:
        current_uid = r[0]
        print(f"  {r[1]} (id={r[0]}):")
    print(f"    {r[2]}")

# 5. Platform config
print()
print("=== Platform Config ===")
try:
    from app.services.merchant_platform_sync import get_platform_config
    for pname in ['CG', 'BSH', 'LH', 'LB', 'PH', 'AW', 'RA', 'PM', 'RW']:
        try:
            cfg = get_platform_config(pname)
            mode = cfg.get('mode', '?')
            ms = cfg.get('max_size', '?')
            print(f"  {pname}: mode={mode}, max_size={ms}")
        except Exception as e:
            print(f"  {pname}: {e}")
except Exception as e:
    print(f"  Error: {e}")

db.close()
""")
sftp.close()

stdin, stdout, stderr = ssh.exec_command(
    "cd /home/admin/Google-Data-Analysis/backend && source venv/bin/activate && python3 /tmp/check_accounts.py 2>&1",
    timeout=30
)
print(stdout.read().decode('utf-8', errors='replace'), flush=True)

ssh.close()
