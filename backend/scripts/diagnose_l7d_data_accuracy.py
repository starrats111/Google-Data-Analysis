"""
诊断 L7D 数据准确性
检查：
1. Google Ads 数据和平台数据的日期覆盖
2. 平台代码匹配情况
3. 商家ID匹配情况
4. 数据缺失情况
"""

import sys
from pathlib import Path
from datetime import date, timedelta

project_root = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(project_root))

from app.database import SessionLocal
from app.models.user import User
from app.models.affiliate_account import AffiliateAccount, AffiliatePlatform
from app.models.platform_data import PlatformData
from app.models.google_ads_api_data import GoogleAdsApiData

db = SessionLocal()

def diagnose_l7d_accuracy(username: str = "wj02"):
    """诊断指定用户的 L7D 数据准确性"""
    
    # 查找用户
    user = db.query(User).filter(User.username == username).first()
    if not user:
        print(f"❌ 用户 {username} 不存在")
        return False
    
    print(f"✅ 用户: {user.username} (ID: {user.id})")
    
    # L7D 日期范围
    end_date = date.today() - timedelta(days=1)
    begin_date = end_date - timedelta(days=6)
    print(f"\n📊 L7D 日期范围: {begin_date} ~ {end_date}")
    
    # 1. 检查 Google Ads 数据
    print(f"\n📈 Google Ads 数据统计:")
    google_data = db.query(GoogleAdsApiData).filter(
        GoogleAdsApiData.user_id == user.id,
        GoogleAdsApiData.date >= begin_date,
        GoogleAdsApiData.date <= end_date
    ).all()
    
    print(f"  总记录数: {len(google_data)}")
    google_dates = set(gd.date for gd in google_data)
    print(f"  覆盖日期数: {len(google_dates)}")
    if google_dates:
        print(f"  日期范围: {min(google_dates)} ~ {max(google_dates)}")
    else:
        print(f"  日期范围: N/A")
    
    # 2. 检查平台数据
    print(f"\n💰 平台数据统计:")
    platform_data = db.query(PlatformData).filter(
        PlatformData.user_id == user.id,
        PlatformData.date >= begin_date,
        PlatformData.date <= end_date
    ).all()
    
    print(f"  总记录数: {len(platform_data)}")
    platform_dates = set(pd.date for pd in platform_data)
    print(f"  覆盖日期数: {len(platform_dates)}")
    if platform_dates:
        print(f"  日期范围: {min(platform_dates)} ~ {max(platform_dates)}")
    else:
        print(f"  日期范围: N/A")
    
    # 3. 检查日期覆盖差异
    print(f"\n🔍 日期覆盖分析:")
    only_google = google_dates - platform_dates
    only_platform = platform_dates - google_dates
    both = google_dates & platform_dates
    
    print(f"  仅有 Google Ads 数据的日期: {len(only_google)} 天")
    if only_google:
        print(f"    → {sorted(only_google)}")
    print(f"  仅有平台数据的日期: {len(only_platform)} 天")
    if only_platform:
        print(f"    → {sorted(only_platform)}")
    print(f"  两者都有的日期: {len(both)} 天")
    
    # 4. 检查平台代码匹配
    print(f"\n🏷️  平台代码匹配分析:")
    platform_codes = set()
    for gd in google_data:
        if gd.extracted_platform_code:
            platform_codes.add(gd.extracted_platform_code)
    
    print(f"  Google Ads 中的平台代码: {platform_codes if platform_codes else 'N/A'}")
    
    for code in platform_codes:
        platform = db.query(AffiliatePlatform).filter(
            AffiliatePlatform.platform_code.ilike(code)
        ).first()
        if platform:
            print(f"  ✅ {code} → 平台 ID={platform.id}, 名称={platform.platform_name}")
        else:
            print(f"  ❌ {code} → 平台不存在于数据库！")
    
    # 5. 检查商家ID匹配
    print(f"\n🏪 商家ID匹配分析:")
    merchant_ids = set()
    for gd in google_data:
        if gd.extracted_account_code:
            merchant_ids.add(gd.extracted_account_code)
    
    print(f"  Google Ads 中的商家ID: {merchant_ids if merchant_ids else 'N/A'}")
    
    for mid in merchant_ids:
        accounts = db.query(AffiliateAccount).filter(
            AffiliateAccount.user_id == user.id,
            AffiliateAccount.account_code == mid
        ).all()
        if accounts:
            print(f"  ✅ {mid} → 找到 {len(accounts)} 个账号")
            for acc in accounts:
                platform = db.query(AffiliatePlatform).filter(
                    AffiliatePlatform.id == acc.platform_id
                ).first()
                print(f"      - 平台: {platform.platform_code if platform else 'N/A'}, 账号: {acc.account_name}")
        else:
            print(f"  ❌ {mid} → 未找到对应账号！")
    
    # 6. 数据完整性检查
    print(f"\n📋 数据完整性检查:")
    
    total_google_cost = sum(gd.cost or 0 for gd in google_data)
    total_platform_commission = sum(pd.commission or 0 for pd in platform_data)
    total_platform_orders = sum(pd.orders or 0 for pd in platform_data)
    
    print(f"  Google Ads 总花费: ${total_google_cost:.2f}")
    print(f"  平台总佣金: ${total_platform_commission:.2f}")
    print(f"  平台总订单数: {int(total_platform_orders)}")
    
    # 7. 检查数据质量
    print(f"\n⚠️  数据质量检查:")
    
    # 检查是否有NULL值
    null_commission = sum(1 for pd in platform_data if pd.commission is None)
    null_orders = sum(1 for pd in platform_data if pd.orders is None)
    
    if null_commission > 0:
        print(f"  ⚠️  平台数据中有 {null_commission} 条记录的佣金为 NULL")
    if null_orders > 0:
        print(f"  ⚠️  平台数据中有 {null_orders} 条记录的订单数为 NULL")
    
    if null_commission == 0 and null_orders == 0:
        print(f"  ✅ 平台数据完整，无 NULL 值")
    
    # 检查是否有异常值（负数）
    negative_commission = sum(1 for pd in platform_data if pd.commission and pd.commission < 0)
    negative_orders = sum(1 for pd in platform_data if pd.orders and pd.orders < 0)
    
    if negative_commission > 0:
        print(f"  ⚠️  平台数据中有 {negative_commission} 条记录的佣金为负数")
    if negative_orders > 0:
        print(f"  ⚠️  平台数据中有 {negative_orders} 条记录的订单数为负数")
    
    if negative_commission == 0 and negative_orders == 0:
        print(f"  ✅ 平台数据无异常值")
    
    print(f"\n✅ 诊断完成")
    return True

if __name__ == "__main__":
    try:
        diagnose_l7d_accuracy()
    except Exception as e:
        print(f"❌ 诊断失败: {e}")
        import traceback
        traceback.print_exc()
    finally:
        db.close()
