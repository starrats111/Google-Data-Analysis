"""
诊断各平台的 MID 字段
"""
import sys
sys.path.insert(0, '.')

from datetime import date, timedelta
from app.database import SessionLocal
from app.models.user import User
from app.models.affiliate_transaction import AffiliateTransaction

db = SessionLocal()

# 查找 wj02 用户
user = db.query(User).filter(User.username == "wj02").first()
if not user:
    print("❌ 用户 wj02 不存在")
    sys.exit(1)

print(f"✅ 用户: {user.username} (ID: {user.id})")

end_date = date.today() - timedelta(days=1)
begin_date = end_date - timedelta(days=6)

# 查看各平台的交易详情
print(f"\n📋 各平台的交易详情:")

# 获取几条不同平台的交易
platforms = ['cg', 'partnermatic', 'linkhaitao', 'rw']

for platform in platforms:
    print(f"\n=== 平台: {platform} ===")
    transactions = db.query(AffiliateTransaction).filter(
        AffiliateTransaction.user_id == user.id,
        AffiliateTransaction.platform == platform
    ).limit(3).all()
    
    if not transactions:
        print("  无交易数据")
        continue
    
    for txn in transactions:
        print(f"  transaction_id: {txn.transaction_id}")
        print(f"  merchant: {txn.merchant}")
        print(f"  merchant_id: {txn.merchant_id}")
        print(f"  commission_amount: {txn.commission_amount}")
        print(f"  ---")

# 检查 AffiliateTransaction 表的所有字段
print(f"\n📊 AffiliateTransaction 表的所有字段:")
from sqlalchemy import inspect
inspector = inspect(AffiliateTransaction)
for column in inspector.columns:
    print(f"  {column.name}: {column.type}")

db.close()
print("\n诊断完成")

