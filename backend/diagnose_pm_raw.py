"""
诊断 PM 平台的原始交易数据
"""
import sys
sys.path.insert(0, '.')

from datetime import date, timedelta
from app.database import SessionLocal
from app.models.user import User
from app.models.affiliate_transaction import AffiliateTransaction
import json

db = SessionLocal()

# 查找 wj02 用户
user = db.query(User).filter(User.username == "wj02").first()
if not user:
    print("❌ 用户 wj02 不存在")
    sys.exit(1)

print(f"✅ 用户: {user.username} (ID: {user.id})")

# 查看 PM 平台的一条交易
print(f"\n📋 PM 平台的交易原始数据:")
transactions = db.query(AffiliateTransaction).filter(
    AffiliateTransaction.user_id == user.id,
    AffiliateTransaction.platform == 'partnermatic'
).limit(3).all()

for txn in transactions:
    print(f"\n=== 交易 {txn.transaction_id} ===")
    print(f"  merchant: {txn.merchant}")
    print(f"  merchant_id: {txn.merchant_id}")
    # 尝试查看是否有 raw_data 字段或其他字段
    for column in txn.__table__.columns:
        value = getattr(txn, column.name)
        if value is not None:
            print(f"  {column.name}: {value}")

db.close()
print("\n诊断完成")

