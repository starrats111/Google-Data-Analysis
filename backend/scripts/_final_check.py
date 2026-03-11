import paramiko, sys
sys.stdout.reconfigure(encoding='utf-8')

ssh = paramiko.SSHClient()
ssh.set_missing_host_key_policy(paramiko.AutoAddPolicy())
ssh.connect("47.239.193.33", username="admin", password="A123456", timeout=10)

sftp = ssh.open_sftp()
with sftp.open("/tmp/final_check.py", "w") as f:
    f.write("""
import sys, os
sys.path.insert(0, "/home/admin/Google-Data-Analysis/backend")
os.chdir("/home/admin/Google-Data-Analysis/backend")

from app.database import SessionLocal
from sqlalchemy import text

db = SessionLocal()

# Active accounts
print("=== Active Accounts ===")
rows = db.execute(text(
    "SELECT aa.user_id, u.username, ap.platform_code, ap.platform_name "
    "FROM affiliate_accounts aa "
    "JOIN users u ON u.id = aa.user_id "
    "JOIN affiliate_platforms ap ON ap.id = aa.platform_id "
    "WHERE aa.is_active = 1 "
    "ORDER BY aa.user_id, ap.platform_code"
)).fetchall()
current_uid = None
for r in rows:
    if r[0] != current_uid:
        current_uid = r[0]
        print(f"  {r[1]} (id={r[0]}):")
    print(f"    {r[2].upper()} ({r[3]})")

# Missing cache
print()
print("=== Missing Cache ===")
accounts = db.execute(text(
    "SELECT aa.user_id, ap.platform_code "
    "FROM affiliate_accounts aa "
    "JOIN affiliate_platforms ap ON ap.id = aa.platform_id "
    "WHERE aa.is_active = 1"
)).fetchall()

cache = db.execute(text(
    "SELECT user_id, platform_code, COUNT(*) "
    "FROM campaign_link_cache "
    "GROUP BY user_id, platform_code"
)).fetchall()
cache_map = {(r[0], r[1].upper()): r[2] for r in cache}

missing = []
low = []
for a in accounts:
    uid = a[0]
    plat = a[1].upper()
    cnt = cache_map.get((uid, plat), 0)
    if cnt == 0:
        missing.append((uid, plat))
    elif cnt < 10:
        low.append((uid, plat, cnt))

if missing:
    print(f"  WARNING: {len(missing)} combos have 0 cache:")
    for uid, plat in missing:
        print(f"    user_id={uid}, platform={plat}")
else:
    print("  All active accounts have cache entries.")

if low:
    print(f"  LOW: {len(low)} combos have <10 entries:")
    for uid, plat, cnt in low:
        print(f"    user_id={uid}, platform={plat}: {cnt}")

# Platform config
print()
print("=== Platform Config ===")
try:
    from app.services.merchant_platform_sync import get_platform_config
    for pname in ['CG', 'BSH', 'LH', 'LB', 'PM', 'RW', 'CF']:
        try:
            cfg = get_platform_config(pname)
            mode = cfg.get('mode', '?')
            ms = cfg.get('max_size', '?')
            print(f"  {pname}: mode={mode}, max_size={ms}")
        except Exception as e:
            print(f"  {pname}: not configured ({e})")
except Exception as e:
    print(f"  Error: {e}")

db.close()
print()
print("Done!")
""")
sftp.close()

stdin, stdout, stderr = ssh.exec_command(
    "cd /home/admin/Google-Data-Analysis/backend && source venv/bin/activate && python3 /tmp/final_check.py 2>&1",
    timeout=30
)
print(stdout.read().decode('utf-8', errors='replace'), flush=True)

ssh.close()
