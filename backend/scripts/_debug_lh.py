import paramiko
import sys

sys.stdout.reconfigure(encoding='utf-8')

ssh = paramiko.SSHClient()
ssh.set_missing_host_key_policy(paramiko.AutoAddPolicy())
ssh.connect("47.239.193.33", username="admin", password="A123456", timeout=10)

def ssh_cmd(ssh, cmd, timeout=120):
    stdin, stdout, stderr = ssh.exec_command(cmd, timeout=timeout)
    return stdout.read().decode('utf-8', errors='replace'), stderr.read().decode('utf-8', errors='replace')

test_code = r'''
import sys, os
sys.path.insert(0, "/home/admin/Google-Data-Analysis/backend")
os.chdir("/home/admin/Google-Data-Analysis/backend")

import httpx
from app.database import SessionLocal
from app.models.affiliate_account import AffiliateAccount, AffiliatePlatform
from app.services.merchant_platform_sync import MerchantPlatformSyncService, PLATFORM_API_CONFIG
from app.services.campaign_link_sync_service import CampaignLinkSyncService

db = SessionLocal()

# 1. Check LH config on server
cfg = PLATFORM_API_CONFIG.get("LH")
print(f"LH config: {cfg}")

# 2. Get LH token
lh = db.query(AffiliatePlatform).filter(AffiliatePlatform.platform_code == "lh").first()
acct = db.query(AffiliateAccount).filter(
    AffiliateAccount.platform_id == lh.id,
    AffiliateAccount.is_active == True,
).first()
token = MerchantPlatformSyncService._resolve_token(acct, "LH")
print(f"Token: {token[:20]}..." if token else "NO TOKEN")

# 3. Direct API call
url = cfg["url"]
print(f"\n=== Direct POST form test ===")
resp = httpx.post(url, data={
    "token": token,
    "page": "1",
    "per_page": "5",
}, timeout=30)
print(f"Status: {resp.status_code}")
raw = resp.json()
print(f"Keys: {list(raw.keys())}")
print(f"code/status: {raw.get('code', raw.get('status'))}")
items = MerchantPlatformSyncService._extract_items(raw)
print(f"Extracted items: {len(items)}")
if items:
    print(f"First item keys: {list(items[0].keys())}")
    print(f"First: mcid={items[0].get('mcid')} name={items[0].get('merchant_name')}")

# 4. Now test via _api_call
print(f"\n=== Test via _api_call ===")
svc = CampaignLinkSyncService(db)
try:
    data = svc._api_call(
        mode=cfg["mode"],
        url=cfg["url"],
        platform_code="LH",
        token=token,
        relationship="Joined",
        page=1,
        per_page=5,
        page_key=cfg["page_key"],
        size_key=cfg["size_key"],
        cfg=cfg,
    )
    print(f"_api_call returned keys: {list(data.keys()) if isinstance(data, dict) else type(data)}")
    items2 = MerchantPlatformSyncService._extract_items(data)
    print(f"Extracted: {len(items2)} items")
except Exception as e:
    print(f"_api_call error: {e}")
    import traceback
    traceback.print_exc()

# 5. Test _extract_mid
if items:
    from app.services.campaign_link_sync_service import CampaignLinkSyncService as CLS
    mid = CLS._extract_mid(items[0], "LH")
    print(f"\n_extract_mid: {mid}")

db.close()
'''

sftp = ssh.open_sftp()
with sftp.open("/tmp/debug_lh.py", "w") as f:
    f.write(test_code)
sftp.close()

out, _ = ssh_cmd(ssh, "cd /home/admin/Google-Data-Analysis/backend && source venv/bin/activate && python3 /tmp/debug_lh.py 2>&1", timeout=60)
print(out)

ssh.close()
