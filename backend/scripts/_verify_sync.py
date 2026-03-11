import paramiko, sys
sys.stdout.reconfigure(encoding='utf-8')

ssh = paramiko.SSHClient()
ssh.set_missing_host_key_policy(paramiko.AutoAddPolicy())
ssh.connect("47.239.193.33", username="admin", password="A123456", timeout=10)

def run(cmd, timeout=30):
    stdin, stdout, stderr = ssh.exec_command(cmd, timeout=timeout)
    return stdout.read().decode('utf-8', errors='replace'), stderr.read().decode('utf-8', errors='replace')

PROJECT = "/home/admin/Google-Data-Analysis"

# 1. Check per-user per-platform cache breakdown
print("=== Per-User Per-Platform Cache ===", flush=True)
out, _ = run(f"""cd {PROJECT}/backend && source venv/bin/activate && python3 -c "
from app.database import SessionLocal
from sqlalchemy import text
db = SessionLocal()
rows = db.execute(text('''
    SELECT user_id, platform, COUNT(*) as cnt 
    FROM campaign_link_cache 
    GROUP BY user_id, platform 
    ORDER BY user_id, platform
''')).fetchall()
current_uid = None
for r in rows:
    if r[0] != current_uid:
        current_uid = r[0]
        print(f'\\nuser_id={r[0]}:')
    print(f'  {r[1]}: {r[2]}')
db.close()
" 2>&1""")
print(out, flush=True)

# 2. Check LH platform config
print("=== Platform Configs ===", flush=True)
out, _ = run(f"""cd {PROJECT}/backend && source venv/bin/activate && python3 -c "
from app.services.campaign_link_sync_service import CampaignLinkSyncService
svc = CampaignLinkSyncService()
# Check what platforms are configured
from app.services.merchant_platform_sync import get_platform_config
for pname in ['CG', 'BSH', 'LH', 'LB', 'PH', 'AW', 'RA']:
    try:
        cfg = get_platform_config(pname)
        print(f"{pname}: mode={cfg.get('mode')}, max_size={cfg.get('max_size')}, base_url={str(cfg.get('base_url',''))[:60]}")
    except Exception as e:
        print(f"{pname}: ERROR - {e}")
" 2>&1""")
print(out, flush=True)

# 3. Check affiliate accounts for all users
print("=== Affiliate Accounts ===", flush=True)
out, _ = run(f"""cd {PROJECT}/backend && source venv/bin/activate && python3 -c "
from app.database import SessionLocal
from sqlalchemy import text
db = SessionLocal()
rows = db.execute(text('''
    SELECT aa.user_id, u.username, ap.code as platform, aa.status
    FROM affiliate_accounts aa
    JOIN users u ON u.id = aa.user_id
    JOIN affiliate_platforms ap ON ap.id = aa.platform_id
    WHERE aa.status = 'active'
    ORDER BY aa.user_id, ap.code
''')).fetchall()
current_uid = None
for r in rows:
    if r[0] != current_uid:
        current_uid = r[0]
        print(f'\\nuser={r[1]} (id={r[0]}):')
    print(f'  {r[2]}: active')
db.close()
" 2>&1""")
print(out, flush=True)

# 4. Check if any user has 0 cache for a platform they have an account for
print("\n=== Missing Cache Check ===", flush=True)
out, _ = run(f"""cd {PROJECT}/backend && source venv/bin/activate && python3 -c "
from app.database import SessionLocal
from sqlalchemy import text
db = SessionLocal()

# Get all active accounts
accounts = db.execute(text('''
    SELECT aa.user_id, ap.code as platform
    FROM affiliate_accounts aa
    JOIN affiliate_platforms ap ON ap.id = aa.platform_id
    WHERE aa.status = 'active'
''')).fetchall()

# Get cache counts
cache = db.execute(text('''
    SELECT user_id, platform, COUNT(*) as cnt
    FROM campaign_link_cache
    GROUP BY user_id, platform
''')).fetchall()
cache_map = {{(r[0], r[1]): r[2] for r in cache}}

missing = []
for a in accounts:
    uid, plat = a[0], a[1]
    cnt = cache_map.get((uid, plat), 0)
    if cnt == 0:
        missing.append((uid, plat))

if missing:
    print(f'WARNING: {len(missing)} user-platform combos have 0 cache:')
    for uid, plat in missing:
        print(f'  user_id={uid}, platform={plat}')
else:
    print('All active accounts have cache entries.')
db.close()
" 2>&1""")
print(out, flush=True)

ssh.close()
print("\nDone!", flush=True)
