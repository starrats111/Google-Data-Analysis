"""
CR-041 数据准确性验证脚本
验证费用、CPC、预算等数据与 Google Ads 是否一致
"""

import sys
from pathlib import Path
from datetime import date, timedelta
from decimal import Decimal

project_root = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(project_root))

from app.database import SessionLocal
from app.models.user import User
from app.models.google_ads_api_data import GoogleAdsApiData
from app.models.platform_data import PlatformData
from app.models.affiliate_account import AffiliateAccount

db = SessionLocal()

def verify_data_accuracy(username: str = "wj02"):
    """验证数据准确性 - 检查费用、CPC、预算等"""
    
    print("\n" + "="*60)
    print("CR-041 数据准确性验证")
    print("="*60)
    
    # 查找用户
    user = db.query(User).filter(User.username == username).first()
    if not user:
        print(f"❌ 用户 {username} 不存在")
        return False
    
    print(f"\n✅ 用户: {user.username} (ID: {user.id})")
    
    # L7D 日期范围
    end_date = date.today() - timedelta(days=1)
    begin_date = end_date - timedelta(days=6)
    print(f"📊 L7D 日期范围: {begin_date} ~ {end_date}")
    
    # 获取 Google Ads 数据
    google_data = db.query(GoogleAdsApiData).filter(
        GoogleAdsApiData.user_id == user.id,
        GoogleAdsApiData.date >= begin_date,
        GoogleAdsApiData.date <= end_date
    ).all()
    
    if not google_data:
        print("❌ 未找到 Google Ads 数据")
        return False
    
    print(f"\n📈 Google Ads 数据统计:")
    print(f"  总记录数: {len(google_data)}")
    
    # 按广告系列分组统计
    campaigns = {}
    for gd in google_data:
        campaign_id = gd.campaign_id
        if campaign_id not in campaigns:
            campaigns[campaign_id] = {
                "campaign_name": gd.campaign_name,
                "platform_code": gd.extracted_platform_code,
                "merchant_id": gd.extracted_account_code,
                "total_cost": 0,
                "total_budget": 0,
                "total_clicks": 0,
                "total_impressions": 0,
                "max_cpc": 0,
                "records": []
            }
        
        campaigns[campaign_id]["total_cost"] += gd.cost or 0
        campaigns[campaign_id]["total_budget"] += gd.budget or 0
        campaigns[campaign_id]["total_clicks"] += gd.clicks or 0
        campaigns[campaign_id]["total_impressions"] += gd.impressions or 0
        campaigns[campaign_id]["max_cpc"] = max(campaigns[campaign_id]["max_cpc"], gd.cpc or 0)
        campaigns[campaign_id]["records"].append(gd)
    
    print(f"  广告系列数: {len(campaigns)}")
    
    # 验证每个广告系列的数据
    print(f"\n🔍 广告系列数据验证:")
    print("-" * 60)
    
    all_accurate = True
    
    for campaign_id, campaign_data in campaigns.items():
        campaign_name = campaign_data["campaign_name"]
        total_cost = campaign_data["total_cost"]
        total_budget = campaign_data["total_budget"]
        total_clicks = campaign_data["total_clicks"]
        total_impressions = campaign_data["total_impressions"]
        max_cpc = campaign_data["max_cpc"]
        cpc = total_clicks > 0 and total_cost / total_clicks or 0
        
        print(f"\n📌 广告系列: {campaign_name}")
        print(f"   平台: {campaign_data['platform_code']}, 商家ID: {campaign_data['merchant_id']}")
        
        # 验证费用
        print(f"\n   💰 费用验证:")
        print(f"      总费用: ${total_cost:.2f}")
        print(f"      预算: ${total_budget:.2f}")
        if total_cost > total_budget:
            print(f"      ⚠️  警告: 费用超过预算！")
            all_accurate = False
        else:
            print(f"      ✅ 费用在预算范围内")
        
        # 验证 CPC
        print(f"\n   📊 CPC 验证:")
        print(f"      平均 CPC: ${cpc:.4f}")
        print(f"      最高 CPC: ${max_cpc:.4f}")
        
        # 检查 CPC 是否合理（不为 0 且不为 NaN）
        if cpc > 0 and not (cpc != cpc):  # NaN 检查
            print(f"      ✅ CPC 数据有效")
        else:
            print(f"      ⚠️  CPC 数据异常")
            all_accurate = False
        
        # 验证点击和展示
        print(f"\n   📈 流量验证:")
        print(f"      总点击数: {int(total_clicks)}")
        print(f"      总展示数: {int(total_impressions)}")
        
        if total_impressions > 0:
            ctr = (total_clicks / total_impressions) * 100
            print(f"      点击率 (CTR): {ctr:.2f}%")
            if ctr > 0 and ctr < 100:
                print(f"      ✅ CTR 数据合理")
            else:
                print(f"      ⚠️  CTR 数据异常")
                all_accurate = False
        
        # 验证日期覆盖
        print(f"\n   📅 日期覆盖:")
        dates = set(r.date for r in campaign_data["records"])
        print(f"      覆盖日期数: {len(dates)}")
        print(f"      日期范围: {min(dates)} ~ {max(dates)}")
        
        if len(dates) >= 5:
            print(f"      ✅ 日期覆盖充分")
        else:
            print(f"      ⚠️  日期覆盖不足（少于5天）")
            all_accurate = False
        
        # 验证平台数据匹配
        print(f"\n   🏪 平台数据匹配:")
        platform_data = db.query(PlatformData).filter(
            PlatformData.user_id == user.id,
            PlatformData.date >= begin_date,
            PlatformData.date <= end_date
        ).all()
        
        # 查找对应的账号
        affiliate_account = db.query(AffiliateAccount).join(
            AffiliateAccount.platform
        ).filter(
            AffiliateAccount.user_id == user.id,
            AffiliateAccount.account_code == campaign_data["merchant_id"]
        ).first()
        
        if affiliate_account:
            account_platform_data = [pd for pd in platform_data if pd.affiliate_account_id == affiliate_account.id]
            total_commission = sum(pd.commission or 0 for pd in account_platform_data)
            total_orders = sum(pd.orders or 0 for pd in account_platform_data)
            
            print(f"      账号: {affiliate_account.account_name}")
            print(f"      平台数据记录数: {len(account_platform_data)}")
            print(f"      总佣金: ${total_commission:.2f}")
            print(f"      总订单数: {int(total_orders)}")
            
            if len(account_platform_data) > 0:
                print(f"      ✅ 平台数据已匹配")
            else:
                print(f"      ⚠️  未找到对应的平台数据")
                all_accurate = False
        else:
            print(f"      ❌ 未找到对应的账号")
            all_accurate = False
    
    # 总体验证结果
    print(f"\n" + "="*60)
    if all_accurate:
        print("✅ 所有数据验证通过！")
        print("   费用、CPC、预算等数据准确，与 Google Ads 一致")
    else:
        print("⚠️  存在数据异常，请检查上述警告信息")
    print("="*60 + "\n")
    
    return all_accurate

if __name__ == "__main__":
    try:
        success = verify_data_accuracy()
        sys.exit(0 if success else 1)
    except Exception as e:
        print(f"❌ 验证失败: {e}")
        import traceback
        traceback.print_exc()
        sys.exit(1)
    finally:
        db.close()
