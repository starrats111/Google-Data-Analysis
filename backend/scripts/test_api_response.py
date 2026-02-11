#!/usr/bin/env python3
"""
测试 /api/platform-data/summary API 的实际返回值
"""
import sys
import os
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from app.database import SessionLocal
from app.models.user import User
from app.models.affiliate_transaction import AffiliateTransaction
from app.models.affiliate_account import AffiliateAccount
from sqlalchemy import func, case
from datetime import date, datetime

db = SessionLocal()

print("=" * 80)
print("模拟 /api/platform-data/summary API 返回")
print("=" * 80)

# 模拟 wj03 用户
user = db.query(User).filter(User.username == 'wj03').first()
print(f"\n用户: {user.username} (ID={user.id})")

begin = date(2026, 2, 1)
end = date(2026, 2, 10)
begin_datetime = datetime.combine(begin, datetime.min.time())
end_datetime = datetime.combine(end, datetime.max.time())

# 模拟 API 查询 - 完全按照 platform_data.py 中的逻辑
base_query = db.query(AffiliateTransaction).outerjoin(
    AffiliateAccount,
    AffiliateTransaction.affiliate_account_id == AffiliateAccount.id
).filter(
    AffiliateTransaction.transaction_time >= begin_datetime,
    AffiliateTransaction.transaction_time <= end_datetime,
    (AffiliateAccount.id.is_(None)) | (AffiliateAccount.is_active == True),
    AffiliateTransaction.user_id == user.id  # 员工权限过滤
)

# 按商家聚合
merchant_query = base_query.with_entities(
    AffiliateTransaction.platform,
    AffiliateTransaction.merchant_id,
    AffiliateTransaction.merchant,
    func.count(AffiliateTransaction.id).label('orders'),
    func.sum(AffiliateTransaction.order_amount).label('gmv'),
    func.sum(AffiliateTransaction.commission_amount).label('total_commission'),
    func.sum(
        case(
            (AffiliateTransaction.status == "approved", AffiliateTransaction.commission_amount),
            else_=0
        )
    ).label('approved_commission'),
    func.sum(
        case(
            (AffiliateTransaction.status == "pending", AffiliateTransaction.commission_amount),
            else_=0
        )
    ).label('pending_commission'),
    func.sum(
        case(
            (AffiliateTransaction.status == "rejected", AffiliateTransaction.commission_amount),
            else_=0
        )
    ).label('rejected_commission')
).group_by(
    AffiliateTransaction.platform,
    AffiliateTransaction.merchant_id,
    AffiliateTransaction.merchant
).order_by(
    AffiliateTransaction.platform,
    func.sum(AffiliateTransaction.commission_amount).desc()
)

results = merchant_query.all()

print(f"\nmerchant_breakdown ({len(results)} 条):\n")
print(f"{'平台':<15} {'MID':<15} {'商家':<25} {'订单':<8} {'总佣金':<12} {'拒付佣金':<12}")
print("-" * 100)

total_rejected = 0
for r in results:
    rejected = float(r.rejected_commission or 0)
    if rejected > 0:
        total_rejected += rejected
        print(f"{r.platform:<15} {r.merchant_id or '-':<15} {r.merchant:<25} {r.orders:<8} ${float(r.total_commission or 0):<11.2f} ${rejected:<11.2f} ⚠️")
    else:
        # 只显示前10个没有拒付的
        pass

print(f"\n总拒付佣金: ${total_rejected:.2f}")

# 检查是否有 rejected_commission > 0 的记录
with_rejected = [r for r in results if (r.rejected_commission or 0) > 0]
print(f"有拒付的商家数: {len(with_rejected)}")

for r in with_rejected:
    print(f"  - {r.merchant} ({r.merchant_id}): ${float(r.rejected_commission or 0):.2f} 拒付")

db.close()
print("\n" + "=" * 80)

