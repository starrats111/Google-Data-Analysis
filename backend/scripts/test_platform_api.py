#!/usr/bin/env python3
"""
测试平台数据API返回
"""
import sys
import os
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from app.database import SessionLocal
from app.models.affiliate_transaction import AffiliateTransaction
from app.models.user import User
from sqlalchemy import func, case, and_
from datetime import date, datetime

db = SessionLocal()

print("=" * 60)
print("测试平台数据API - 检查 merchant_breakdown")
print("=" * 60)

begin = date(2026, 2, 1)
end = date(2026, 2, 10)

# 获取wj03用户
user = db.query(User).filter(User.username == 'wj03').first()
if not user:
    print("找不到 wj03 用户")
    db.close()
    exit()

print(f"\n用户: {user.username} (ID={user.id})")

# 模拟 merchant_breakdown 查询
begin_datetime = datetime.combine(begin, datetime.min.time())
end_datetime = datetime.combine(end, datetime.max.time())

base_filter = and_(
    AffiliateTransaction.user_id == user.id,
    AffiliateTransaction.transaction_time >= begin_datetime,
    AffiliateTransaction.transaction_time <= end_datetime
)

merchant_query = db.query(
    AffiliateTransaction.platform,
    AffiliateTransaction.merchant_id,
    AffiliateTransaction.merchant,
    func.count(AffiliateTransaction.id).label('orders'),
    func.sum(AffiliateTransaction.commission_amount).label('total_commission'),
    func.sum(
        case(
            (AffiliateTransaction.status == "rejected", AffiliateTransaction.commission_amount),
            else_=0
        )
    ).label('rejected_commission')
).filter(base_filter).group_by(
    AffiliateTransaction.platform,
    AffiliateTransaction.merchant_id,
    AffiliateTransaction.merchant
).order_by(
    func.sum(AffiliateTransaction.commission_amount).desc()
)

results = merchant_query.all()

print(f"\n按商家聚合结果 ({len(results)} 条):\n")
print(f"{'平台':<6} {'MID':<12} {'商家':<20} {'订单':<6} {'总佣金':<12} {'拒付佣金':<12}")
print("-" * 80)

for r in results[:15]:  # 只显示前15条
    platform = r.platform or ""
    mid = r.merchant_id or ""
    merchant = (r.merchant or "")[:18]
    orders = int(r.orders or 0)
    total_comm = float(r.total_commission or 0)
    rejected_comm = float(r.rejected_commission or 0)
    
    print(f"{platform:<6} {mid:<12} {merchant:<20} {orders:<6} ${total_comm:<11.2f} ${rejected_comm:<11.2f}")

# 特别检查 TA3 商家
print("\n" + "=" * 60)
print("特别检查 TA3 (18653684) 商家:")
print("=" * 60)

ta3_query = db.query(
    AffiliateTransaction.status,
    func.count(AffiliateTransaction.id).label('count'),
    func.sum(AffiliateTransaction.commission_amount).label('total')
).filter(
    AffiliateTransaction.user_id == user.id,
    AffiliateTransaction.merchant_id == '18653684',
    AffiliateTransaction.transaction_time >= begin_datetime,
    AffiliateTransaction.transaction_time <= end_datetime
).group_by(AffiliateTransaction.status).all()

for s in ta3_query:
    print(f"  {s.status}: {s.count} 笔, ${s.total:.2f}")

db.close()
print("\n" + "=" * 60)

