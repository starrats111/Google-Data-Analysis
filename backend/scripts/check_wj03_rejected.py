#!/usr/bin/env python3
"""
详细检查 wj03 的 CG 平台拒付数据
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

print("=" * 80)
print("wj03 的 CG 平台拒付数据详情")
print("=" * 80)

user = db.query(User).filter(User.username == 'wj03').first()
print(f"\n用户: {user.username} (ID={user.id})")

begin = date(2026, 2, 1)
end = date(2026, 2, 10)
begin_datetime = datetime.combine(begin, datetime.min.time())
end_datetime = datetime.combine(end, datetime.max.time())

# 查询 wj03 的所有 CG 拒付
rejected_txns = db.query(AffiliateTransaction).filter(
    AffiliateTransaction.user_id == user.id,
    AffiliateTransaction.platform == 'cg',
    AffiliateTransaction.status == 'rejected',
    AffiliateTransaction.transaction_time >= begin_datetime,
    AffiliateTransaction.transaction_time <= end_datetime
).order_by(AffiliateTransaction.merchant).all()

print(f"\n2026年2月 CG平台拒付数据 ({len(rejected_txns)} 笔):")
print("-" * 80)

by_merchant = {}
for txn in rejected_txns:
    key = (txn.merchant_id, txn.merchant)
    if key not in by_merchant:
        by_merchant[key] = {'count': 0, 'total': 0}
    by_merchant[key]['count'] += 1
    by_merchant[key]['total'] += txn.commission_amount or 0

print("\n按商家分组:")
for (mid, merchant), data in sorted(by_merchant.items(), key=lambda x: -x[1]['total']):
    print(f"  {merchant} ({mid}): {data['count']} 笔, ${data['total']:.2f}")

# 检查 API 返回的 merchant_breakdown 是否包含拒付
print("\n" + "=" * 80)
print("模拟 API 查询 - 检查 rejected_commission 计算")
print("=" * 80)

# 按商家聚合（包含状态）
agg = db.query(
    AffiliateTransaction.merchant_id.label('mid'),
    AffiliateTransaction.merchant,
    AffiliateTransaction.status,
    func.count(AffiliateTransaction.id).label('count'),
    func.sum(AffiliateTransaction.commission_amount).label('total')
).filter(
    AffiliateTransaction.user_id == user.id,
    AffiliateTransaction.platform == 'cg',
    AffiliateTransaction.transaction_time >= begin_datetime,
    AffiliateTransaction.transaction_time <= end_datetime
).group_by(
    AffiliateTransaction.merchant_id,
    AffiliateTransaction.merchant,
    AffiliateTransaction.status
).all()

# 组装为 merchant_breakdown 格式
breakdown = {}
for r in agg:
    key = (r.mid, r.merchant)
    if key not in breakdown:
        breakdown[key] = {
            'mid': r.mid,
            'merchant': r.merchant,
            'orders': 0,
            'total_commission': 0,
            'rejected_commission': 0,
            'net_commission': 0
        }
    
    if r.status == 'rejected':
        breakdown[key]['rejected_commission'] += r.total or 0
    else:
        breakdown[key]['orders'] += r.count
        breakdown[key]['total_commission'] += r.total or 0

# 计算净佣金
for k, v in breakdown.items():
    v['net_commission'] = v['total_commission'] - v['rejected_commission']

print("\nmerchant_breakdown (有拒付的商家):")
for k, v in sorted(breakdown.items(), key=lambda x: -x[1]['rejected_commission']):
    if v['rejected_commission'] > 0:
        print(f"  {v['merchant']} ({v['mid']})")
        print(f"    订单: {v['orders']}, 总佣金: ${v['total_commission']:.2f}")
        print(f"    拒付: ${v['rejected_commission']:.2f}, 净佣金: ${v['net_commission']:.2f}")

db.close()
print("\n" + "=" * 80)

