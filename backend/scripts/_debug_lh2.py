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

import json
from app.database import SessionLocal
from app.models.affiliate_account import AffiliateAccount, AffiliatePlatform
from app.models.campaign_link_cache import CampaignLinkCache
from app.services.campaign_link_sync_service import CampaignLinkSyncService
from app.services.campaign_link_service import CampaignLinkService
from app.services.merchant_platform_sync import MerchantPlatformSyncService, PLATFORM_API_CONFIG

db = SessionLocal()

lh = db.query(AffiliatePlatform).filter(AffiliatePlatform.platform_code == "lh").first()
acct = db.query(AffiliateAccount).filter(
    AffiliateAccount.platform_id == lh.id,
    AffiliateAccount.is_active == True,
).first()
token = MerchantPlatformSyncService._resolve_token(acct, "LH")
cfg = PLATFORM_API_CONFIG["LH"]

svc = CampaignLinkSyncService(db)

# Step 1: Test _fetch_all_joined
print("=== _fetch_all_joined ===")
items = svc._fetch_all_joined(cfg, "LH", token)
print(f"Total items fetched: {len(items)}")
if items:
    print(f"First item: mcid={items[0].get('mcid')} name={items[0].get('merchant_name')}")

# Step 2: Test _extract_mid on LH items
if items:
    print(f"\n=== _extract_mid test ===")
    mid = svc._extract_mid(items[0], "LH")
    print(f"mid={mid}")
    
    # Step 3: Test _map_campaign_response
    mapped = CampaignLinkService._map_campaign_response(items[0], "LH")
    print(f"\n=== _map_campaign_response ===")
    for k, v in mapped.items():
        val = str(v)[:80] if v else "None"
        print(f"  {k}: {val}")

# Step 4: Manual sync test - just first 5 items
if items:
    print(f"\n=== Manual write test (5 items) ===")
    from datetime import datetime
    now = datetime.utcnow()
    count = 0
    for raw in items[:5]:
        mid = svc._extract_mid(raw, "LH")
        if not mid:
            print(f"  SKIP: no mid for {raw.get('merchant_name')}")
            continue
        
        mapped = CampaignLinkService._map_campaign_response(raw, "LH")
        support_regions_json = json.dumps(mapped.get("support_regions") or [], ensure_ascii=False)
        
        try:
            existing = db.query(CampaignLinkCache).filter(
                CampaignLinkCache.user_id == acct.user_id,
                CampaignLinkCache.platform_code == "LH",
                CampaignLinkCache.merchant_id == mid,
            ).first()
            
            if existing:
                existing.synced_at = now
                print(f"  UPDATE: mid={mid} name={mapped.get('merchant_name')}")
            else:
                record = CampaignLinkCache(
                    user_id=acct.user_id,
                    platform_code="LH",
                    merchant_id=mid,
                    campaign_link=mapped.get("campaign_link"),
                    short_link=mapped.get("short_link"),
                    smart_link=mapped.get("smart_link"),
                    site_url=mapped.get("site_url"),
                    merchant_name=mapped.get("merchant_name"),
                    support_regions=support_regions_json,
                    categories=json.dumps(mapped.get("categories") or "", ensure_ascii=False) if mapped.get("categories") else None,
                    commission_rate=mapped.get("commission_rate"),
                    logo=mapped.get("logo"),
                    synced_at=now,
                )
                db.add(record)
                print(f"  INSERT: mid={mid} name={mapped.get('merchant_name')}")
            count += 1
        except Exception as e:
            print(f"  ERROR: {e}")
            import traceback
            traceback.print_exc()
    
    try:
        db.commit()
        print(f"\nCommitted {count} records")
    except Exception as e:
        print(f"\nCommit error: {e}")
        db.rollback()

# Step 5: Verify
after = db.query(CampaignLinkCache).filter(
    CampaignLinkCache.user_id == acct.user_id,
    CampaignLinkCache.platform_code == "LH",
).count()
print(f"\nLH cache for user {acct.user_id}: {after} entries")

db.close()
'''

sftp = ssh.open_sftp()
with sftp.open("/tmp/debug_lh2.py", "w") as f:
    f.write(test_code)
sftp.close()

out, _ = ssh_cmd(ssh, "cd /home/admin/Google-Data-Analysis/backend && source venv/bin/activate && python3 /tmp/debug_lh2.py 2>&1", timeout=120)
print(out)

ssh.close()
