#!/usr/bin/env python
"""
诊断平台数据汇总模式
"""
import sys
sys.path.insert(0, '.')

from datetime import datetime, timedelta
from sqlalchemy import func, case
from app.database import SessionLocal
from app.models.user import User
from app.models.affiliate_transaction import AffiliateTransaction
from app.models.affiliate_account import AffiliateAccount

db = SessionLocal()

print("=" * 70)
print("诊断平台数据汇总模式")
print("=" * 70)

# 获取用户
user = db.query(User).filter(User.username == "wj07").first()
if not user:
    print("❌ 用户 wj07 不存在")
    sys.exit(1)

print(f"✅ 用户: {user.username} (ID: {user.id})")

# 日期范围
end_date = datetime.now()
begin_date = end_date - timedelta(days=7)
begin_datetime = datetime.combine(begin_date.date(), datetime.min.time())
end_datetime = datetime.combine(end_date.date(), datetime.max.time())

print(f"📅 日期范围: {begin_date.date()} ~ {end_date.date()}")

# 1. 检查原始交易数量（不 join AffiliateAccount）
raw_count = db.query(func.count(AffiliateTransaction.id)).filter(
    AffiliateTransaction.user_id == user.id,
    AffiliateTransaction.transaction_time >= begin_datetime,
    AffiliateTransaction.transaction_time <= end_datetime
).scalar()
print(f"\n📊 原始交易数量（不过滤账号）: {raw_count}")

# 2. 检查有 affiliate_account_id 的交易
with_account_id = db.query(func.count(AffiliateTransaction.id)).filter(
    AffiliateTransaction.user_id == user.id,
    AffiliateTransaction.transaction_time >= begin_datetime,
    AffiliateTransaction.transaction_time <= end_datetime,
    AffiliateTransaction.affiliate_account_id.isnot(None)
).scalar()
print(f"📊 有 affiliate_account_id 的交易: {with_account_id}")

# 3. 检查 affiliate_account_id 为 None 的交易
without_account_id = db.query(func.count(AffiliateTransaction.id)).filter(
    AffiliateTransaction.user_id == user.id,
    AffiliateTransaction.transaction_time >= begin_datetime,
    AffiliateTransaction.transaction_time <= end_datetime,
    AffiliateTransaction.affiliate_account_id.is_(None)
).scalar()
print(f"📊 affiliate_account_id 为 None 的交易: {without_account_id}")

# 4. 用 outerjoin 查询（模拟后端逻辑）
outerjoin_count = db.query(func.count(AffiliateTransaction.id)).outerjoin(
    AffiliateAccount,
    AffiliateTransaction.affiliate_account_id == AffiliateAccount.id
).filter(
    AffiliateTransaction.user_id == user.id,
    AffiliateTransaction.transaction_time >= begin_datetime,
    AffiliateTransaction.transaction_time <= end_datetime,
    (AffiliateAccount.id.is_(None)) | (AffiliateAccount.is_active == True)
).scalar()
print(f"📊 outerjoin 后（排除停用账号）: {outerjoin_count}")

# 5. 检查有多少交易关联到已停用的账号
disabled_account_txn = db.query(func.count(AffiliateTransaction.id)).join(
    AffiliateAccount,
    AffiliateTransaction.affiliate_account_id == AffiliateAccount.id
).filter(
    AffiliateTransaction.user_id == user.id,
    AffiliateTransaction.transaction_time >= begin_datetime,
    AffiliateTransaction.transaction_time <= end_datetime,
    AffiliateAccount.is_active == False
).scalar()
print(f"📊 关联到已停用账号的交易: {disabled_account_txn}")

# 6. 检查商家聚合结果
print("\n📋 商家聚合结果:")
merchant_query = db.query(
    AffiliateTransaction.platform,
    AffiliateTransaction.merchant_id,
    AffiliateTransaction.merchant,
    func.count(AffiliateTransaction.id).label('orders'),
    func.sum(AffiliateTransaction.commission_amount).label('total_commission'),
).outerjoin(
    AffiliateAccount,
    AffiliateTransaction.affiliate_account_id == AffiliateAccount.id
).filter(
    AffiliateTransaction.user_id == user.id,
    AffiliateTransaction.transaction_time >= begin_datetime,
    AffiliateTransaction.transaction_time <= end_datetime,
    (AffiliateAccount.id.is_(None)) | (AffiliateAccount.is_active == True)
).group_by(
    AffiliateTransaction.platform,
    AffiliateTransaction.merchant_id,
    AffiliateTransaction.merchant
).all()

print(f"共 {len(merchant_query)} 条商家聚合记录")
for r in merchant_query[:5]:
    print(f"  - 平台: {r.platform}, MID: {r.merchant_id}, 商家: {r.merchant}, 订单: {r.orders}, 佣金: ${r.total_commission:.2f}")

db.close()
print("\n诊断完成")

