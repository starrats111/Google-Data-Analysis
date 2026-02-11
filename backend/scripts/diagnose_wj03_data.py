"""
诊断 wj03 平台数据差异
对比系统数据与平台后台数据
"""
import sys
import os
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from datetime import date
from sqlalchemy import func, and_
from app.database import SessionLocal
from app.models.user import User
from app.models.affiliate_transaction import AffiliateTransaction
from app.models.affiliate_account import AffiliateAccount, AffiliatePlatform

def diagnose_wj03():
    db = SessionLocal()
    
    try:
        # 查找 wj03
        user = db.query(User).filter(User.username == 'wj03').first()
        if not user:
            print("用户 wj03 不存在")
            return
        
        print(f"用户: {user.username} (ID={user.id})")
        print("=" * 80)
        
        # 日期范围
        start_date = date(2026, 2, 1)
        end_date = date(2026, 2, 11)
        print(f"日期范围: {start_date} ~ {end_date}")
        print()
        
        # 获取用户的平台账号
        accounts = db.query(AffiliateAccount).filter(
            AffiliateAccount.user_id == user.id
        ).all()
        
        print(f"平台账号数: {len(accounts)}")
        for acc in accounts:
            platform = db.query(AffiliatePlatform).filter(AffiliatePlatform.id == acc.platform_id).first()
            print(f"  - {platform.platform_name if platform else '?'}: {acc.account_name} (ID={acc.id})")
        print()
        
        # 按平台统计交易
        print("=" * 80)
        print("按平台统计（所有状态）")
        print("=" * 80)
        
        platform_stats = db.query(
            AffiliateTransaction.platform,
            func.count(AffiliateTransaction.id).label('order_count'),
            func.sum(AffiliateTransaction.commission_amount).label('total_commission')
        ).filter(
            AffiliateTransaction.user_id == user.id,
            AffiliateTransaction.transaction_time >= start_date,
            AffiliateTransaction.transaction_time <= end_date
        ).group_by(AffiliateTransaction.platform).all()
        
        total_orders = 0
        total_commission = 0
        for stat in platform_stats:
            orders = stat.order_count or 0
            commission = float(stat.total_commission or 0)
            total_orders += orders
            total_commission += commission
            print(f"  {stat.platform}: {orders} 单, ${commission:.2f}")
        
        print(f"\n  总计: {total_orders} 单, ${total_commission:.2f}")
        
        # 按状态统计
        print()
        print("=" * 80)
        print("按状态统计")
        print("=" * 80)
        
        status_stats = db.query(
            AffiliateTransaction.status,
            func.count(AffiliateTransaction.id).label('order_count'),
            func.sum(AffiliateTransaction.commission_amount).label('total_commission')
        ).filter(
            AffiliateTransaction.user_id == user.id,
            AffiliateTransaction.transaction_time >= start_date,
            AffiliateTransaction.transaction_time <= end_date
        ).group_by(AffiliateTransaction.status).all()
        
        for stat in status_stats:
            orders = stat.order_count or 0
            commission = float(stat.total_commission or 0)
            print(f"  {stat.status}: {orders} 单, ${commission:.2f}")
        
        # 检查是否有重复订单
        print()
        print("=" * 80)
        print("检查重复订单（同一transaction_id出现多次）")
        print("=" * 80)
        
        duplicate_check = db.query(
            AffiliateTransaction.transaction_id,
            AffiliateTransaction.platform,
            func.count(AffiliateTransaction.id).label('count')
        ).filter(
            AffiliateTransaction.user_id == user.id,
            AffiliateTransaction.transaction_time >= start_date,
            AffiliateTransaction.transaction_time <= end_date
        ).group_by(
            AffiliateTransaction.transaction_id,
            AffiliateTransaction.platform
        ).having(func.count(AffiliateTransaction.id) > 1).all()
        
        if duplicate_check:
            print(f"  发现 {len(duplicate_check)} 个重复的transaction_id:")
            for dup in duplicate_check[:10]:  # 只显示前10个
                print(f"    {dup.platform}: {dup.transaction_id} (出现 {dup.count} 次)")
        else:
            print("  没有发现重复订单")
        
        # CG平台详细分析
        print()
        print("=" * 80)
        print("CG平台详细分析")
        print("=" * 80)
        
        cg_stats = db.query(
            AffiliateTransaction.status,
            func.count(AffiliateTransaction.id).label('order_count'),
            func.sum(AffiliateTransaction.commission_amount).label('total_commission')
        ).filter(
            AffiliateTransaction.user_id == user.id,
            AffiliateTransaction.platform == 'cg',
            AffiliateTransaction.transaction_time >= start_date,
            AffiliateTransaction.transaction_time <= end_date
        ).group_by(AffiliateTransaction.status).all()
        
        cg_total_orders = 0
        cg_total_commission = 0
        for stat in cg_stats:
            orders = stat.order_count or 0
            commission = float(stat.total_commission or 0)
            cg_total_orders += orders
            cg_total_commission += commission
            print(f"  {stat.status}: {orders} 单, ${commission:.2f}")
        
        print(f"\n  CG总计: {cg_total_orders} 单, ${cg_total_commission:.2f}")
        print(f"  平台后台显示: 428 单, $2,199.59 (All)")
        print(f"  差异: {cg_total_orders - 428} 单, ${cg_total_commission - 2199.59:.2f}")
        
    finally:
        db.close()

if __name__ == "__main__":
    diagnose_wj03()

