"""
查看 wj07 (朱文欣) 的RW账号详细信息
了解渠道ID/API Token的存储情况
"""
import sys
import os
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from app.database import SessionLocal
from app.models.user import User
from app.models.affiliate_account import AffiliateAccount, AffiliatePlatform

db = SessionLocal()

# 找到 wj07 用户
user = db.query(User).filter(User.username == 'wj07').first()
if not user:
    print("用户 wj07 不存在！")
    db.close()
    exit()

print(f"找到用户: {user.username} (ID={user.id})")

# 找到 RW 平台
rw_platform = db.query(AffiliatePlatform).filter(AffiliatePlatform.platform_name == 'RW').first()
if not rw_platform:
    print("RW 平台不存在！")
    db.close()
    exit()

print(f"找到平台: {rw_platform.platform_name} (ID={rw_platform.id})")

# 查找 wj07 在 RW 平台的所有账号
rw_accounts = db.query(AffiliateAccount).filter(
    AffiliateAccount.user_id == user.id,
    AffiliateAccount.platform_id == rw_platform.id
).all()

print(f"\nwj07 在 RW 平台的账号详情 ({len(rw_accounts)} 个):")
print("-" * 80)
for acc in rw_accounts:
    print(f"  ID: {acc.id}")
    print(f"  account_name: {acc.account_name}")
    print(f"  account_code (渠道ID): {acc.account_code}")
    print(f"  email: {acc.email}")
    print(f"  notes: {acc.notes}")
    print(f"  is_active: {acc.is_active}")
    print("-" * 80)

db.close()

print("\n请告诉我：")
print("1. 这3个账号的渠道ID (account_code) 分别是什么？")
print("2. 是否需要新建一个表来支持'一个账号多个渠道ID'的结构？")

