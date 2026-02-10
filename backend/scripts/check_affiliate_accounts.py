"""
查询员工平台账号数据
"""
import sys
import os
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from app.database import SessionLocal
from app.models.user import User
from app.models.affiliate_account import AffiliateAccount, AffiliatePlatform

db = SessionLocal()

# 先查看所有平台
print("=" * 80)
print("平台列表")
print("=" * 80)
platforms = db.query(AffiliatePlatform).all()
for p in platforms:
    print(f"  ID={p.id}, name={p.platform_name}, code={p.platform_code}")

# 平台代码映射
PLATFORM_SHORT = {
    'collabglow': 'CG',
    'brandsparkhub': 'BSH',
    'linkbux': 'LB',
    'partnermatic': 'PM',
    'linkhaitao': 'LH',
    'rewardoo': 'RW',
    'creatorflare': 'CF',
}

def get_short_code(platform_code):
    for key, short in PLATFORM_SHORT.items():
        if key in platform_code.lower():
            return short
    return platform_code

# 获取所有员工（排除管理员）
users = db.query(User).filter(User.role == 'employee').order_by(User.username).all()

print("\n" + "=" * 80)
print("员工平台账号数据")
print("=" * 80)

for user in users:
    accounts = db.query(AffiliateAccount).join(AffiliatePlatform).filter(
        AffiliateAccount.user_id == user.id,
        AffiliateAccount.is_active == True
    ).all()
    
    if accounts:
        print(f"\n【{user.username}】")
        for acc in accounts:
            platform_code = acc.platform.platform_code if acc.platform else "未知"
            short_code = get_short_code(platform_code)
            print(f"  - {short_code}: {acc.account_name}")

print("\n" + "=" * 80)
db.close()

