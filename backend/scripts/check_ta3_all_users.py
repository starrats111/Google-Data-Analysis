#!/usr/bin/env python3
"""
检查 TA3 商家的拒付数据属于哪个用户
"""
import sys
import os
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from app.database import SessionLocal
from app.models.affiliate_transaction import AffiliateTransaction
from app.models.user import User
from sqlalchemy import func
from datetime import date, datetime

db = SessionLocal()

print("=" * 60)
print("检查 TA3 (18653684) 商家的拒付数据属于哪个用户")
print("=" * 60)

begin = date(2026, 2, 1)
end = date(2026, 2, 10)
begin_datetime = datetime.combine(begin, datetime.min.time())
end_datetime = datetime.combine(end, datetime.max.time())

# 查询所有用户的 TA3 拒付数据
results = db.query(
    User.username,
    AffiliateTransaction.status,
    func.count(AffiliateTransaction.id).label('count'),
    func.sum(AffiliateTransaction.commission_amount).label('total')
).join(
    User, AffiliateTransaction.user_id == User.id
).filter(
    AffiliateTransaction.merchant_id == '18653684',
    AffiliateTransaction.transaction_time >= begin_datetime,
    AffiliateTransaction.transaction_time <= end_datetime
).group_by(
    User.username,
    AffiliateTransaction.status
).order_by(
    User.username,
    AffiliateTransaction.status
).all()

print("\n2026年2月 TA3 商家数据按用户分组：\n")
current_user = None
for r in results:
    if r.username != current_user:
        if current_user:
            print()
        print(f"【{r.username}】")
        current_user = r.username
    print(f"  {r.status}: {r.count} 笔, ${r.total:.2f}")

# 检查 CG 平台 2月份所有拒付数据的用户分布
print("\n" + "=" * 60)
print("CG平台 2月份拒付数据按用户分组：")
print("=" * 60 + "\n")

cg_rejected = db.query(
    User.username,
    func.count(AffiliateTransaction.id).label('count'),
    func.sum(AffiliateTransaction.commission_amount).label('total')
).join(
    User, AffiliateTransaction.user_id == User.id
).filter(
    AffiliateTransaction.platform == 'cg',
    AffiliateTransaction.status == 'rejected',
    AffiliateTransaction.transaction_time >= begin_datetime,
    AffiliateTransaction.transaction_time <= end_datetime
).group_by(
    User.username
).order_by(
    func.sum(AffiliateTransaction.commission_amount).desc()
).all()

for r in cg_rejected:
    print(f"  {r.username}: {r.count} 笔拒付, ${r.total:.2f}")

db.close()
print("\n" + "=" * 60)

