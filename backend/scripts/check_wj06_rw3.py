import paramiko

ssh = paramiko.SSHClient()
ssh.set_missing_host_key_policy(paramiko.AutoAddPolicy())
ssh.connect('47.239.193.33', port=22, username='admin', password='A123456', timeout=15)

script = r"""
cd /home/admin/Google-Data-Analysis/backend && source venv/bin/activate && python3 << 'PYEOF'
from app.database import SessionLocal
from app.models.user import User
from app.models.google_ads_api_data import GoogleAdsApiData
from app.models.affiliate_account import AffiliateAccount, AffiliatePlatform
from app.models.platform_data import PlatformData
from sqlalchemy import func
from datetime import date

db = SessionLocal()
user = db.query(User).filter(User.username == 'wj06').first()

# 关键问题验证: L7D分析中的匹配逻辑
# api_analysis_service.py 第175行:
#   AffiliatePlatform.platform_name == platform_code
# 其中 platform_code = campaign.extracted_platform_code = 'rw' (小写)
# 但 AffiliatePlatform.platform_name = 'Rewardoo' (全名)

# 测试1: 用 platform_name 匹配 (当前代码逻辑)
acc1 = db.query(AffiliateAccount).join(AffiliatePlatform).filter(
    AffiliateAccount.user_id == user.id,
    AffiliatePlatform.platform_name == 'rw',
    AffiliateAccount.is_active == True
).first()
print(f"Test1: platform_name == 'rw' => {acc1}")

# 测试2: 用 platform_name 匹配大写
acc2 = db.query(AffiliateAccount).join(AffiliatePlatform).filter(
    AffiliateAccount.user_id == user.id,
    AffiliatePlatform.platform_name == 'RW',
    AffiliateAccount.is_active == True
).first()
print(f"Test2: platform_name == 'RW' => {acc2}")

# 测试3: 用 platform_code 匹配 (正确的方式)
acc3 = db.query(AffiliateAccount).join(AffiliatePlatform).filter(
    AffiliateAccount.user_id == user.id,
    AffiliatePlatform.platform_code == 'rw',
    AffiliateAccount.is_active == True
).first()
print(f"Test3: platform_code == 'rw' => {acc3} (account_name={acc3.account_name if acc3 else 'N/A'})")

# 测试4: 用 platform_name 匹配 'Rewardoo'
acc4 = db.query(AffiliateAccount).join(AffiliatePlatform).filter(
    AffiliateAccount.user_id == user.id,
    AffiliatePlatform.platform_name == 'Rewardoo',
    AffiliateAccount.is_active == True
).first()
print(f"Test4: platform_name == 'Rewardoo' => {acc4} (account_name={acc4.account_name if acc4 else 'N/A'})")

# 检查所有用户的 extracted_platform_code 值
all_codes = db.query(
    GoogleAdsApiData.extracted_platform_code,
    func.count(GoogleAdsApiData.id)
).filter(
    GoogleAdsApiData.extracted_platform_code.isnot(None)
).group_by(GoogleAdsApiData.extracted_platform_code).all()

print(f"\n=== All extracted_platform_code values in DB ===")
for code, cnt in all_codes:
    print(f"  '{code}' => {cnt} records")

# 检查 api_only_analysis_service.py 中的匹配逻辑
# 它也用 AffiliatePlatform.platform_name == platform_code.upper()
# 'rw'.upper() = 'RW', 但 platform_name = 'Rewardoo'
# 所以也匹配不上！

print(f"\n=== 匹配逻辑分析 ===")
print(f"extracted_platform_code 存储的值: 小写 (rw, cg, pm, cf, lb, lh)")
print(f"AffiliatePlatform.platform_name 存储的值: 全名 (Rewardoo, CollabGlow, PartnerMatic...)")
print(f"AffiliatePlatform.platform_code 存储的值: 小写简码 (rw, cg, pm, cf, lb, lh)")
print(f"")
print(f"api_analysis_service.py 第175行:")
print(f"  AffiliatePlatform.platform_name == platform_code")
print(f"  => 'Rewardoo' == 'rw' => FALSE (匹配失败!)")
print(f"")
print(f"正确应该用:")
print(f"  AffiliatePlatform.platform_code == platform_code")
print(f"  => 'rw' == 'rw' => TRUE")

db.close()
PYEOF
"""

stdin, stdout, stderr = ssh.exec_command(script, timeout=60)
print(stdout.read().decode())
err = stderr.read().decode()
if err:
    lines = [l for l in err.split('\n') if l.strip() and 'WARNING' not in l and 'DeprecationWarning' not in l]
    if lines:
        print('STDERR:', '\n'.join(lines[-10:]))

ssh.close()
