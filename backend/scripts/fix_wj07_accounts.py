"""
修复 wj07 (朱文欣) 的重复RW账号
将3个RW账号合并为1个: wenjun
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

print(f"\nwj07 在 RW 平台的账号 ({len(rw_accounts)} 个):")
for acc in rw_accounts:
    print(f"  ID={acc.id}, account_name={acc.account_name}, is_active={acc.is_active}")

# 保留 wenjun，删除其他的
keep_account = None
delete_accounts = []

for acc in rw_accounts:
    if acc.account_name == 'wenjun':
        keep_account = acc
    else:
        delete_accounts.append(acc)

if not keep_account:
    print("\n没有找到 'wenjun' 账号，创建一个新的...")
    # 如果没有 wenjun，就把第一个改名
    if rw_accounts:
        rw_accounts[0].account_name = 'wenjun'
        keep_account = rw_accounts[0]
        delete_accounts = rw_accounts[1:]
        db.commit()
        print(f"  已将 ID={keep_account.id} 改名为 'wenjun'")

print(f"\n保留账号: ID={keep_account.id}, account_name={keep_account.account_name}")
print(f"删除账号: {[acc.id for acc in delete_accounts]}")

# 确认删除
confirm = input("\n确认删除这些重复账号? (yes/no): ")
if confirm.lower() == 'yes':
    for acc in delete_accounts:
        db.delete(acc)
    db.commit()
    print("删除完成！")
else:
    print("取消操作")

# 验证结果
print("\n验证结果:")
rw_accounts_after = db.query(AffiliateAccount).filter(
    AffiliateAccount.user_id == user.id,
    AffiliateAccount.platform_id == rw_platform.id
).all()
for acc in rw_accounts_after:
    print(f"  ID={acc.id}, account_name={acc.account_name}")

db.close()

