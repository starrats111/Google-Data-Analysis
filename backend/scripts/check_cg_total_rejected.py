#!/usr/bin/env python3
"""
检查 CG 平台 2 月份总拒付佣金
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
print("CG 平台 2月份拒付数据统计")
print("=" * 80)

begin = date(2026, 2, 1)
end = date(2026, 2, 11)  # 到今天
begin_datetime = datetime.combine(begin, datetime.min.time())
end_datetime = datetime.combine(end, datetime.max.time())

# 按状态汇总 CG 平台的佣金
status_summary = db.query(
    AffiliateTransaction.status,
    func.count(AffiliateTransaction.id).label('count'),
    func.sum(AffiliateTransaction.commission_amount).label('total')
).filter(
    AffiliateTransaction.platform == 'cg',
    AffiliateTransaction.transaction_time >= begin_datetime,
    AffiliateTransaction.transaction_time <= end_datetime
).group_by(
    AffiliateTransaction.status
).all()

print(f"\n2026年2月 CG平台按状态统计 ({begin} ~ {end}):")
print("-" * 50)
for r in status_summary:
    print(f"  {r.status}: {r.count} 笔, ${r.total:.2f}")

# 按用户汇总拒付
print(f"\n2026年2月 CG平台拒付按用户统计:")
print("-" * 50)

user_rejected = db.query(
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

total_rejected = 0
for r in user_rejected:
    print(f"  {r.username}: {r.count} 笔, ${r.total:.2f}")
    total_rejected += r.total

print(f"\n总拒付: ${total_rejected:.2f}")

# CG平台后台显示的拒付是 $261.57
print(f"\n与CG后台对比:")
print(f"  CG后台显示: $261.57")
print(f"  系统记录:   ${total_rejected:.2f}")
print(f"  差额:       ${261.57 - total_rejected:.2f}")

# 检查是否有未同步的数据
print(f"\n可能的原因:")
print("  1. CG平台后台的日期范围可能不同")
print("  2. 部分拒付数据可能还未同步到系统")
print("  3. CG后台可能包含了本月所有拒付（包括pending转rejected的）")

db.close()
print("\n" + "=" * 80)

