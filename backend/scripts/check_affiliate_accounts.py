"""
查询员工平台账号数据
"""
import sys
sys.path.insert(0, '/root/Google-Data-Analysis/backend')

from app.database import SessionLocal
from app.models.user import User
from app.models.affiliate_account import AffiliateAccount, AffiliatePlatform

db = SessionLocal()

# 获取所有员工（排除管理员）
users = db.query(User).filter(User.role == 'employee').order_by(User.username).all()

print("=" * 80)
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
            print(f"  - {platform_code}: {acc.account_name}")

print("\n" + "=" * 80)
db.close()

