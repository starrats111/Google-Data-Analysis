import paramiko
import sys
import time

sys.stdout.reconfigure(encoding='utf-8')

ssh = paramiko.SSHClient()
ssh.set_missing_host_key_policy(paramiko.AutoAddPolicy())
ssh.connect("47.239.193.33", username="admin", password="A123456", timeout=10)

def ssh_cmd(ssh, cmd, timeout=300):
    stdin, stdout, stderr = ssh.exec_command(cmd, timeout=timeout)
    return stdout.read().decode('utf-8', errors='replace'), stderr.read().decode('utf-8', errors='replace')

PROJECT = "/home/admin/Google-Data-Analysis"
DB = f"{PROJECT}/backend/google_analysis.db"

# 1. Check current cache state
print("=== Current cache state ===")
out, _ = ssh_cmd(ssh, f"""python3 -c "
import sqlite3
conn = sqlite3.connect('{DB}')
c = conn.cursor()
c.execute('SELECT platform_code, COUNT(*) FROM campaign_link_cache GROUP BY platform_code ORDER BY platform_code')
total = 0
for r in c.fetchall():
    print(f'  {{r[0]}}: {{r[1]}}')
    total += r[1]
print(f'  TOTAL: {{total}}')
conn.close()
" """)
print(out)

# 2. Deploy latest code
print("=== Deploy ===")
out, _ = ssh_cmd(ssh, f"cd {PROJECT} && git fetch origin && git reset --hard origin/main 2>&1")
print(out)

# 3. Restart
print("=== Restart ===")
ssh_cmd(ssh, "pkill -9 -f uvicorn 2>/dev/null; sleep 1; fuser -k 8000/tcp 2>/dev/null; sleep 2")
transport = ssh.get_transport()
channel = transport.open_session()
channel.exec_command(f"cd {PROJECT}/backend && source venv/bin/activate && PYTHONUNBUFFERED=1 nohup uvicorn app.main:app --host 0.0.0.0 --port 8000 > /home/admin/backend.log 2>&1 &")
time.sleep(6)
out, _ = ssh_cmd(ssh, "curl -s http://localhost:8000/health")
print(f"Health: {out}")

# 4. Check LH sync logs
print("\n=== Recent LH sync logs ===")
out, _ = ssh_cmd(ssh, "grep -i 'LH\\|linkhaitao' /home/admin/backend.log | tail -10")
print(out or "(none)")

# 5. Test LH sync for one user
print("\n=== Test LH sync ===")
test_code = r'''
import sys, os
sys.path.insert(0, "/home/admin/Google-Data-Analysis/backend")
os.chdir("/home/admin/Google-Data-Analysis/backend")

from app.database import SessionLocal
from app.models.affiliate_account import AffiliateAccount, AffiliatePlatform
from app.models.campaign_link_cache import CampaignLinkCache
from app.services.campaign_link_sync_service import CampaignLinkSyncService
from app.services.merchant_platform_sync import MerchantPlatformSyncService

db = SessionLocal()

lh = db.query(AffiliatePlatform).filter(AffiliatePlatform.platform_code == "lh").first()
if lh:
    acct = db.query(AffiliateAccount).filter(
        AffiliateAccount.platform_id == lh.id,
        AffiliateAccount.is_active == True,
    ).first()
    if acct:
        token = MerchantPlatformSyncService._resolve_token(acct, "LH")
        print(f"LH account: {acct.account_name} (user_id={acct.user_id})")
        
        svc = CampaignLinkSyncService(db)
        try:
            count = svc._sync_platform(acct.user_id, "LH", token)
            print(f"Synced: {count} LH entries")
        except Exception as e:
            print(f"Error: {e}")
            import traceback
            traceback.print_exc()

db.close()
'''

sftp = ssh.open_sftp()
with sftp.open("/tmp/test_lh.py", "w") as f:
    f.write(test_code)
sftp.close()

out, _ = ssh_cmd(ssh, f"cd {PROJECT}/backend && source venv/bin/activate && python3 /tmp/test_lh.py 2>&1", timeout=120)
print(out)

ssh.close()
