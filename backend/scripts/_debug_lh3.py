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
import sys, os, time, json, logging
sys.path.insert(0, "/home/admin/Google-Data-Analysis/backend")
os.chdir("/home/admin/Google-Data-Analysis/backend")

logging.basicConfig(level=logging.DEBUG, format="%(levelname)s %(message)s")

import httpx
from app.database import SessionLocal
from app.models.affiliate_account import AffiliateAccount, AffiliatePlatform
from app.services.merchant_platform_sync import MerchantPlatformSyncService, PLATFORM_API_CONFIG
from app.services.campaign_link_sync_service import CampaignLinkSyncService

db = SessionLocal()

lh = db.query(AffiliatePlatform).filter(AffiliatePlatform.platform_code == "lh").first()
acct = db.query(AffiliateAccount).filter(
    AffiliateAccount.platform_id == lh.id,
    AffiliateAccount.is_active == True,
).first()
token = MerchantPlatformSyncService._resolve_token(acct, "LH")
cfg = PLATFORM_API_CONFIG["LH"]

svc = CampaignLinkSyncService(db)

# Manually step through _fetch_all_joined
mode = cfg["mode"]
url = cfg["url"]
page_key = cfg["page_key"]
size_key = cfg["size_key"]
max_size = cfg["max_size"]

print(f"Config: mode={mode} page_key={page_key} size_key={size_key} max_size={max_size}")
print(f"skip_relationship_filter={cfg.get('skip_relationship_filter')}")

# Step 1: Call _api_call directly
print("\n=== Step 1: _api_call ===")
try:
    data = svc._api_call(mode, url, "LH", token, "Joined", 1, max_size, page_key, size_key, cfg)
    print(f"Success! type={type(data)} keys={list(data.keys()) if isinstance(data, dict) else 'N/A'}")
    items = MerchantPlatformSyncService._extract_items(data)
    print(f"Extracted: {len(items)} items")
    if items:
        print(f"First: {items[0].get('mcid')} {items[0].get('merchant_name')}")
except Exception as e:
    print(f"ERROR: {e}")
    import traceback
    traceback.print_exc()

# Step 2: Also try with smaller per_page
print("\n=== Step 2: per_page=100 ===")
try:
    data = svc._api_call(mode, url, "LH", token, "Joined", 1, 100, page_key, size_key, cfg)
    items = MerchantPlatformSyncService._extract_items(data)
    print(f"Extracted: {len(items)} items")
    total = data.get("total", "N/A") if isinstance(data, dict) else "N/A"
    print(f"API total: {total}")
except Exception as e:
    print(f"ERROR: {e}")

# Step 3: Check if LH returns status=0 (error) vs code=0 (success)
print("\n=== Step 3: Raw response check ===")
try:
    resp = httpx.post(url, data={
        "token": token,
        "page": "1",
        "per_page": "5000",
    }, timeout=60)
    raw = resp.json()
    print(f"Status code: {resp.status_code}")
    print(f"Response code/status: code={raw.get('code')} status={raw.get('status')} msg={raw.get('msg', raw.get('info'))}")
    if isinstance(raw.get("list"), list):
        print(f"list length: {len(raw['list'])}")
    print(f"total: {raw.get('total')}")
except Exception as e:
    print(f"ERROR: {e}")

db.close()
'''

sftp = ssh.open_sftp()
with sftp.open("/tmp/debug_lh3.py", "w") as f:
    f.write(test_code)
sftp.close()

out, _ = ssh_cmd(ssh, "cd /home/admin/Google-Data-Analysis/backend && source venv/bin/activate && python3 /tmp/debug_lh3.py 2>&1", timeout=120)
print(out)

ssh.close()
