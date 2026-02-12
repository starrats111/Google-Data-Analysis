"""
测试脚本：检查所有用户(wj01-wj10)的平台交易数据MID完整性
"""
import sys
import os
sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), '..')))

from datetime import date, timedelta
from sqlalchemy import func
from app.database import SessionLocal
from app.models.user import User
from app.models.affiliate_transaction import AffiliateTransaction

def test_mid_integrity():
    db = SessionLocal()
    
    print("=" * 80)
    print("MID完整性测试报告")
    print("=" * 80)
    print(f"测试时间: {date.today()}")
    print(f"数据范围: 本月 ({date(date.today().year, date.today().month, 1)} ~ {date.today()})")
    print("=" * 80)
    
    # 定义日期范围（本月）
    today = date.today()
    month_start = date(today.year, today.month, 1)
    
    # 获取所有wj01-wj10用户
    users = db.query(User).filter(
        User.username.in_([f'wj{str(i).zfill(2)}' for i in range(1, 11)])
    ).order_by(User.username).all()
    
    overall_total = 0
    overall_with_mid = 0
    
    for user in users:
        print(f"\n【{user.username}】 {user.display_name or ''}")
        print("-" * 60)
        
        # 按平台统计
        platform_stats = db.query(
            AffiliateTransaction.platform,
            func.count(AffiliateTransaction.id).label('total'),
            func.count(AffiliateTransaction.merchant_id).label('with_mid')
        ).filter(
            AffiliateTransaction.user_id == user.id,
            AffiliateTransaction.transaction_time >= month_start,
            AffiliateTransaction.transaction_time <= today + timedelta(days=1)
        ).group_by(AffiliateTransaction.platform).all()
        
        if not platform_stats:
            print("  无交易数据")
            continue
        
        user_total = 0
        user_with_mid = 0
        
        for stat in platform_stats:
            platform = stat.platform.upper() if stat.platform else 'UNKNOWN'
            total = stat.total
            with_mid = stat.with_mid
            rate = (with_mid / total * 100) if total > 0 else 0
            
            # 状态标记
            if rate == 100:
                status = "✅"
            elif rate >= 80:
                status = "⚠️"
            else:
                status = "❌"
            
            print(f"  {status} {platform:10} | 总计: {total:4} | 有MID: {with_mid:4} | 比例: {rate:6.1f}%")
            
            user_total += total
            user_with_mid += with_mid
        
        user_rate = (user_with_mid / user_total * 100) if user_total > 0 else 0
        print(f"  {'─' * 50}")
        print(f"  合计: {user_total} 条, MID完整率: {user_rate:.1f}%")
        
        overall_total += user_total
        overall_with_mid += user_with_mid
    
    # 总体统计
    print("\n" + "=" * 80)
    print("总体统计")
    print("=" * 80)
    overall_rate = (overall_with_mid / overall_total * 100) if overall_total > 0 else 0
    print(f"总交易数: {overall_total}")
    print(f"有MID数: {overall_with_mid}")
    print(f"MID完整率: {overall_rate:.1f}%")
    
    # 按平台统计总体情况
    print("\n" + "-" * 40)
    print("按平台汇总:")
    print("-" * 40)
    
    platform_overall = db.query(
        AffiliateTransaction.platform,
        func.count(AffiliateTransaction.id).label('total'),
        func.count(AffiliateTransaction.merchant_id).label('with_mid')
    ).filter(
        AffiliateTransaction.transaction_time >= month_start,
        AffiliateTransaction.transaction_time <= today + timedelta(days=1)
    ).group_by(AffiliateTransaction.platform).order_by(AffiliateTransaction.platform).all()
    
    for stat in platform_overall:
        platform = stat.platform.upper() if stat.platform else 'UNKNOWN'
        total = stat.total
        with_mid = stat.with_mid
        rate = (with_mid / total * 100) if total > 0 else 0
        
        if rate == 100:
            status = "✅"
        elif rate >= 80:
            status = "⚠️"
        else:
            status = "❌"
        
        print(f"  {status} {platform:12} | 总计: {total:5} | 有MID: {with_mid:5} | 比例: {rate:6.1f}%")
    
    # 显示MID缺失的样例
    print("\n" + "=" * 80)
    print("MID缺失样例 (最多显示10条)")
    print("=" * 80)
    
    missing_samples = db.query(AffiliateTransaction).filter(
        AffiliateTransaction.transaction_time >= month_start,
        AffiliateTransaction.merchant_id == None
    ).limit(10).all()
    
    if missing_samples:
        for tx in missing_samples:
            user = db.query(User).filter(User.id == tx.user_id).first()
            username = user.username if user else f"ID:{tx.user_id}"
            print(f"  [{username}] {tx.platform.upper():6} | {tx.merchant[:30]:30} | {tx.transaction_time.strftime('%m-%d')}")
    else:
        print("  没有MID缺失的记录 ✅")
    
    print("\n" + "=" * 80)
    print("测试完成")
    print("=" * 80)
    
    db.close()

if __name__ == "__main__":
    test_mid_integrity()

