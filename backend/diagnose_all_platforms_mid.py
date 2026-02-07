#!/usr/bin/env python
"""
诊断所有平台的 MID 字段
检查 PM, CG, RW, LH 四个平台的交易数据中是否正确提取了 MID
"""
import sys
sys.path.insert(0, '.')

from datetime import datetime, timedelta
from app.database import SessionLocal
from app.models.user import User
from app.models.affiliate_account import AffiliatePlatform, AffiliateAccount
from app.models.affiliate_transaction import AffiliateTransaction

db = SessionLocal()

print("=" * 70)
print("诊断所有平台的 MID 字段")
print("=" * 70)

# 获取用户
user = db.query(User).filter(User.username == "wj02").first()
if not user:
    print("❌ 用户 wj02 不存在")
    sys.exit(1)

print(f"✅ 用户: {user.username} (ID: {user.id})")

# 获取所有平台
platforms = db.query(AffiliatePlatform).all()
print(f"\n共 {len(platforms)} 个平台\n")

# 日期范围
end_date = datetime.now().date()
begin_date = end_date - timedelta(days=7)

for platform in platforms:
    platform_code = platform.platform_name or platform.platform_code
    print(f"\n{'='*50}")
    print(f"平台: {platform.platform_name} ({platform.platform_code})")
    print(f"{'='*50}")
    
    # 查询该平台该用户的交易
    transactions = db.query(AffiliateTransaction).filter(
        AffiliateTransaction.user_id == user.id,
        AffiliateTransaction.platform == platform.platform_name.lower()
    ).order_by(AffiliateTransaction.transaction_time.desc()).limit(5).all()
    
    if not transactions:
        # 也尝试用平台代码
        transactions = db.query(AffiliateTransaction).filter(
            AffiliateTransaction.user_id == user.id,
            AffiliateTransaction.platform.ilike(f"%{platform.platform_name[:2]}%")
        ).order_by(AffiliateTransaction.transaction_time.desc()).limit(5).all()
    
    if not transactions:
        print(f"  ⚠️ 无交易数据")
        continue
    
    print(f"  找到 {len(transactions)} 条交易记录（最多显示5条）:")
    
    has_mid = False
    for tx in transactions:
        mid_status = "✅" if tx.merchant_id else "❌ None"
        if tx.merchant_id:
            has_mid = True
        print(f"    - ID: {tx.transaction_id[:30] if tx.transaction_id else 'N/A'}")
        print(f"      商家: {tx.merchant}")
        print(f"      MID: {mid_status} {tx.merchant_id if tx.merchant_id else ''}")
        print(f"      佣金: ${tx.commission_amount:.2f}")
        print()
    
    if has_mid:
        print(f"  ✅ 该平台 MID 已正确提取")
    else:
        print(f"  ❌ 该平台 MID 未提取，需要修复！")

# 汇总各平台状态
print("\n" + "=" * 70)
print("MID 提取状态汇总")
print("=" * 70)

for platform in platforms:
    # 统计有 MID 和无 MID 的交易数
    with_mid = db.query(AffiliateTransaction).filter(
        AffiliateTransaction.user_id == user.id,
        AffiliateTransaction.platform.ilike(f"%{platform.platform_name[:2]}%"),
        AffiliateTransaction.merchant_id.isnot(None),
        AffiliateTransaction.merchant_id != 'None',
        AffiliateTransaction.merchant_id != ''
    ).count()
    
    without_mid = db.query(AffiliateTransaction).filter(
        AffiliateTransaction.user_id == user.id,
        AffiliateTransaction.platform.ilike(f"%{platform.platform_name[:2]}%"),
        (AffiliateTransaction.merchant_id.is_(None) | 
         (AffiliateTransaction.merchant_id == 'None') |
         (AffiliateTransaction.merchant_id == ''))
    ).count()
    
    total = with_mid + without_mid
    if total > 0:
        pct = (with_mid / total) * 100
        status = "✅" if pct >= 90 else ("⚠️" if pct >= 50 else "❌")
        print(f"  {status} {platform.platform_name}: {with_mid}/{total} ({pct:.1f}%) 有 MID")
    else:
        print(f"  ⚠️ {platform.platform_name}: 无交易数据")

db.close()
print("\n诊断完成")
