import paramiko, sys
sys.stdout.reconfigure(encoding='utf-8')

ssh = paramiko.SSHClient()
ssh.set_missing_host_key_policy(paramiko.AutoAddPolicy())
ssh.connect("47.239.193.33", username="admin", password="A123456", timeout=10)

PROJECT = "/home/admin/Google-Data-Analysis"

# Upload script to server
sftp = ssh.open_sftp()
with sftp.open("/tmp/verify_sync.py", "w") as f:
    f.write("""
import sys, os
sys.path.insert(0, "/home/admin/Google-Data-Analysis/backend")
os.chdir("/home/admin/Google-Data-Analysis/backend")

from app.database import SessionLocal
from sqlalchemy import text

db = SessionLocal()

# 1. Per-user per-platform cache
print("=== Per-User Per-Platform Cache ===")
rows = db.execute(text(
    "SELECT user_id, platform, COUNT(*) as cnt "
    "FROM campaign_link_cache "
    "GROUP BY user_id, platform "
    "ORDER BY user_id, platform"
)).fetchall()
current_uid = None
for r in rows:
    if r[0] != current_uid:
        current_uid = r[0]
        print(f"  user_id={r[0]}:")
    print(f"    {r[1]}: {r[2]}")

# 2. Platform configs
print()
print("=== Platform Configs ===")
try:
    from app.services.merchant_platform_sync import get_platform_config
    for pname in ['CG', 'BSH', 'LH', 'LB', 'PH', 'AW', 'RA']:
        try:
            cfg = get_platform_config(pname)
            mode = cfg.get('mode', '?')
            ms = cfg.get('max_size', '?')
            bu = str(cfg.get('base_url', ''))[:60]
            print(f"  {pname}: mode={mode}, max_size={ms}, base={bu}")
        except Exception as e:
            print(f"  {pname}: ERROR - {e}")
except ImportError as e:
    print(f"  Import error: {e}")

# 3. Active affiliate accounts
print()
print("=== Active Affiliate Accounts ===")
rows = db.execute(text(
    "SELECT aa.user_id, u.username, ap.code as platform "
    "FROM affiliate_accounts aa "
    "JOIN users u ON u.id = aa.user_id "
    "JOIN affiliate_platforms ap ON ap.id = aa.platform_id "
    "WHERE aa.status = 'active' "
    "ORDER BY aa.user_id, ap.code"
)).fetchall()
current_uid = None
for r in rows:
    if r[0] != current_uid:
        current_uid = r[0]
        print(f"  {r[1]} (id={r[0]}):")
    print(f"    {r[2]}")

# 4. Missing cache check
print()
print("=== Missing Cache Check ===")
accounts = db.execute(text(
    "SELECT aa.user_id, ap.code as platform "
    "FROM affiliate_accounts aa "
    "JOIN affiliate_platforms ap ON ap.id = aa.platform_id "
    "WHERE aa.status = 'active'"
)).fetchall()

cache = db.execute(text(
    "SELECT user_id, platform, COUNT(*) as cnt "
    "FROM campaign_link_cache "
    "GROUP BY user_id, platform"
)).fetchall()
cache_map = {(r[0], r[1]): r[2] for r in cache}

missing = []
for a in accounts:
    uid, plat = a[0], a[1]
    cnt = cache_map.get((uid, plat), 0)
    if cnt == 0:
        missing.append((uid, plat))

if missing:
    print(f"  WARNING: {len(missing)} user-platform combos have 0 cache:")
    for uid, plat in missing:
        print(f"    user_id={uid}, platform={plat}")
else:
    print("  All active accounts have cache entries.")

db.close()
print()
print("Done!")
""")
sftp.close()

stdin, stdout, stderr = ssh.exec_command(
    f"cd {PROJECT}/backend && source venv/bin/activate && python3 /tmp/verify_sync.py 2>&1",
    timeout=30
)
print(stdout.read().decode('utf-8', errors='replace'), flush=True)

ssh.close()
