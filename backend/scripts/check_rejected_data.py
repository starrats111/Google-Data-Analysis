#!/usr/bin/env python3
"""
诊断脚本：检查拒付佣金数据
"""
import sys
import os
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from app.database import SessionLocal
from app.models.affiliate_transaction import AffiliateTransaction
from app.models.user import User
from sqlalchemy import func
from datetime import date

db = SessionLocal()

print("=" * 60)
print("检查拒付佣金数据")
print("=" * 60)

# 查询所有不同的状态值
print("\n1. 数据库中所有交易状态值:")
statuses = db.query(
    AffiliateTransaction.status,
    func.count(AffiliateTransaction.id).label('count'),
    func.sum(AffiliateTransaction.commission_amount).label('total')
).group_by(AffiliateTransaction.status).all()

for s in statuses:
    print(f"   {s.status}: {s.count} 笔, ${s.total:.2f}")

# 查询2月份CG平台的拒付数据
print("\n2. 2026年2月CG平台各状态数据:")
start_date = date(2026, 2, 1)
end_date = date(2026, 2, 10)

cg_data = db.query(
    AffiliateTransaction.status,
    func.count(AffiliateTransaction.id).label('count'),
    func.sum(AffiliateTransaction.commission_amount).label('total')
).filter(
    AffiliateTransaction.platform == 'cg',
    func.date(AffiliateTransaction.transaction_time) >= start_date,
    func.date(AffiliateTransaction.transaction_time) <= end_date
).group_by(AffiliateTransaction.status).all()

for s in cg_data:
    print(f"   {s.status}: {s.count} 笔, ${s.total:.2f}")

# 查询TA3 (18653684) 商家的数据
print("\n3. TA3 (MID=18653684) 商家2月份数据:")
ta3_data = db.query(
    AffiliateTransaction.status,
    func.count(AffiliateTransaction.id).label('count'),
    func.sum(AffiliateTransaction.commission_amount).label('total')
).filter(
    AffiliateTransaction.merchant_id == '18653684',
    func.date(AffiliateTransaction.transaction_time) >= start_date,
    func.date(AffiliateTransaction.transaction_time) <= end_date
).group_by(AffiliateTransaction.status).all()

if ta3_data:
    for s in ta3_data:
        print(f"   {s.status}: {s.count} 笔, ${s.total:.2f}")
else:
    print("   无数据")

# 检查 raw_status 字段
print("\n4. CG平台的原始状态值 (raw_status):")
raw_statuses = db.query(
    AffiliateTransaction.raw_status,
    func.count(AffiliateTransaction.id).label('count')
).filter(
    AffiliateTransaction.platform == 'cg'
).group_by(AffiliateTransaction.raw_status).all()

for s in raw_statuses:
    print(f"   {s.raw_status}: {s.count} 笔")

db.close()
print("\n" + "=" * 60)

