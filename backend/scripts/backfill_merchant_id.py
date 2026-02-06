"""
回填脚本：为已有的 AffiliateTransaction 记录补充 merchant_id
通过重新调用平台API获取MID数据
"""
import os
import sys
sys.path.insert(0, os.path.dirname(os.path.dirname(__file__)))

from app.database import SessionLocal
from app.models.affiliate_transaction import AffiliateTransaction
from app.models.affiliate_account import AffiliateAccount, AffiliatePlatform
from sqlalchemy import func

def backfill():
    db = SessionLocal()
    
    # 统计当前缺少merchant_id的记录
    total = db.query(AffiliateTransaction).count()
    missing = db.query(AffiliateTransaction).filter(
        AffiliateTransaction.merchant_id == None
    ).count()
    
    print(f"交易总数: {total}")
    print(f"缺少merchant_id: {missing}")
    
    if missing == 0:
        print("所有记录都已有merchant_id，无需回填")
        db.close()
        return
    
    # 方案：重新同步平台数据时，会自动更新merchant_id
    # 这里先尝试从现有数据中用merchant名字去找mcid的映射
    
    # 查看各平台缺失情况
    platform_stats = db.query(
        AffiliateTransaction.platform,
        func.count(AffiliateTransaction.id)
    ).filter(
        AffiliateTransaction.merchant_id == None
    ).group_by(AffiliateTransaction.platform).all()
    
    print("\n各平台缺失 merchant_id 统计:")
    for platform, count in platform_stats:
        print(f"  {platform}: {count} 条")
    
    # 查看每个平台的商家名样例
    for platform, _ in platform_stats:
        samples = db.query(
            AffiliateTransaction.merchant,
            func.count(AffiliateTransaction.id).label('cnt')
        ).filter(
            AffiliateTransaction.platform == platform,
            AffiliateTransaction.merchant_id == None,
            AffiliateTransaction.merchant != None
        ).group_by(AffiliateTransaction.merchant).order_by(func.count(AffiliateTransaction.id).desc()).limit(5).all()
        
        print(f"\n  {platform} 平台 top 商家:")
        for merchant, cnt in samples:
            print(f"    {merchant}: {cnt} 条")
    
    print("\n" + "="*60)
    print("建议操作：重新同步平台数据即可自动回填 merchant_id")
    print("1. 登录网站 → 平台数据同步 → 重新同步全部平台")
    print("2. 新同步的数据会自动包含 merchant_id")
    print("="*60)
    
    db.close()

if __name__ == "__main__":
    backfill()

