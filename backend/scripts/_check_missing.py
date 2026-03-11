import paramiko, sys
sys.stdout.reconfigure(encoding='utf-8')

ssh = paramiko.SSHClient()
ssh.set_missing_host_key_policy(paramiko.AutoAddPolicy())
ssh.connect("47.239.193.33", username="admin", password="A123456", timeout=10)

sftp = ssh.open_sftp()
with sftp.open("/tmp/check_missing.py", "w") as f:
    f.write("""
import sys, os
sys.path.insert(0, "/home/admin/Google-Data-Analysis/backend")
os.chdir("/home/admin/Google-Data-Analysis/backend")

from app.database import SessionLocal
from sqlalchemy import text
from app.models.affiliate_account import AffiliateAccount, AffiliatePlatform
from app.services.merchant_platform_sync import MerchantPlatformSyncService, PLATFORM_API_CONFIG
from app.utils.crypto import decrypt_token

db = SessionLocal()

# Check missing combos
missing = [
    (4, 'CF'),   # wj03
    (7, 'CF'),   # wj06
    (5, 'BSH'),  # wj04
    (5, 'RW'),   # wj04
]

for uid, plat_code in missing:
    print(f"=== user_id={uid}, platform={plat_code} ===")
    
    # Find account
    acct = (
        db.query(AffiliateAccount)
        .join(AffiliatePlatform)
        .filter(
            AffiliateAccount.user_id == uid,
            AffiliatePlatform.platform_code == plat_code.lower(),
            AffiliateAccount.is_active == True,
        )
        .first()
    )
    
    if not acct:
        print(f"  No active account found!")
        continue
    
    print(f"  Account: {acct.account_name} (id={acct.id})")
    print(f"  Has token: {bool(acct.api_token_encrypted)}")
    
    # Try to resolve token
    token = MerchantPlatformSyncService._resolve_token(acct, plat_code)
    if not token:
        print(f"  Token: EMPTY/INVALID")
    else:
        print(f"  Token: {token[:20]}...{token[-10:]}")
    
    # Check if platform config exists
    cfg = PLATFORM_API_CONFIG.get(plat_code)
    if cfg:
        print(f"  Config: mode={cfg.get('mode')}, url={cfg.get('url','')[:50]}")
    else:
        print(f"  Config: NOT FOUND")
    
    print()

db.close()
""")
sftp.close()

stdin, stdout, stderr = ssh.exec_command(
    "cd /home/admin/Google-Data-Analysis/backend && source venv/bin/activate && python3 /tmp/check_missing.py 2>&1",
    timeout=30
)
print(stdout.read().decode('utf-8', errors='replace'), flush=True)

ssh.close()
