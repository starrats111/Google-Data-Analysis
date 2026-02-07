"""
诊断 L7D 佣金数据问题
"""
import sys
sys.path.insert(0, '.')

from datetime import date, timedelta
from app.database import SessionLocal
from app.models.user import User
from app.models.affiliate_account import AffiliateAccount, AffiliatePlatform
from app.models.platform_data import PlatformData
from app.models.google_ads_api_data import GoogleAdsApiData

db = SessionLocal()

# 查找 wj02 用户
user = db.query(User).filter(User.username == "wj02").first()
if not user:
    print("❌ 用户 wj02 不存在")
    sys.exit(1)

print(f"✅ 用户: {user.username} (ID: {user.id})")

# 检查联盟账号
accounts = db.query(AffiliateAccount).filter(
    AffiliateAccount.user_id == user.id,
    AffiliateAccount.is_active == True
).all()

print(f"\n📋 联盟账号数量: {len(accounts)}")
for acc in accounts:
    platform = db.query(AffiliatePlatform).filter(AffiliatePlatform.id == acc.platform_id).first()
    print(f"  - ID={acc.id}, 平台={platform.platform_code if platform else 'N/A'}, 账号名={acc.account_name}")

# 检查平台数据
end_date = date.today() - timedelta(days=1)
begin_date = end_date - timedelta(days=6)

print(f"\n📊 L7D 日期范围: {begin_date} ~ {end_date}")

for acc in accounts:
    platform = db.query(AffiliatePlatform).filter(AffiliatePlatform.id == acc.platform_id).first()
    pcode = platform.platform_code if platform else "N/A"
    
    platform_data = db.query(PlatformData).filter(
        PlatformData.affiliate_account_id == acc.id,
        PlatformData.date >= begin_date,
        PlatformData.date <= end_date
    ).all()
    
    total_commission = sum(pd.commission or 0 for pd in platform_data)
    total_orders = sum(pd.orders or 0 for pd in platform_data)
    
    print(f"\n  平台 {pcode} (账号ID={acc.id}):")
    print(f"    - PlatformData 记录数: {len(platform_data)}")
    print(f"    - L7D 佣金总计: ${total_commission:.2f}")
    print(f"    - L7D 订单总计: {total_orders}")
    
    if platform_data:
        for pd in platform_data[:3]:  # 只显示前3条
            print(f"      日期={pd.date}, 佣金=${pd.commission:.2f}, 订单={pd.orders}")

# 检查 Google Ads 数据中的平台代码
print(f"\n📈 Google Ads 数据中的平台代码:")
google_data = db.query(GoogleAdsApiData).filter(
    GoogleAdsApiData.user_id == user.id,
    GoogleAdsApiData.date >= begin_date,
    GoogleAdsApiData.date <= end_date
).all()

platform_codes = set()
for gd in google_data:
    if gd.extracted_platform_code:
        platform_codes.add(gd.extracted_platform_code)

print(f"  广告系列中的平台代码: {platform_codes}")

# 标准化后的代码
import re
normalized = set()
for pc in platform_codes:
    norm = re.sub(r'\d+$', '', pc) if pc else None
    if norm:
        normalized.add(norm)

print(f"  标准化后的平台代码: {normalized}")

# 检查平台是否存在
print(f"\n🔍 检查平台是否在数据库中存在:")
for norm_code in normalized:
    platform = db.query(AffiliatePlatform).filter(
        AffiliatePlatform.platform_code == norm_code
    ).first()
    if platform:
        print(f"  ✅ {norm_code} -> 平台ID={platform.id}, 名称={platform.platform_name}")
        
        # 检查该用户是否有这个平台的账号
        user_acc = db.query(AffiliateAccount).filter(
            AffiliateAccount.user_id == user.id,
            AffiliateAccount.platform_id == platform.id,
            AffiliateAccount.is_active == True
        ).first()
        if user_acc:
            print(f"      用户有此平台账号: ID={user_acc.id}")
        else:
            print(f"      ❌ 用户没有此平台的联盟账号！")
    else:
        print(f"  ❌ {norm_code} -> 平台不存在于数据库！")

db.close()
print("\n诊断完成")

