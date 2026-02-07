#!/usr/bin/env python
"""
诊断 CG 平台 API 返回的原始字段
找到正确的 MID 字段
"""
import sys
import json
sys.path.insert(0, '.')

from datetime import datetime, timedelta
from app.database import SessionLocal
from app.models.user import User
from app.models.affiliate_account import AffiliatePlatform, AffiliateAccount
from app.services.collabglow_service import CollabGlowService
from app.services.api_config_service import ApiConfigService

db = SessionLocal()

print("=" * 70)
print("诊断 CG 平台 API 返回的原始字段")
print("=" * 70)

# 获取用户
user = db.query(User).filter(User.username == "wj07").first()
if not user:
    print("❌ 用户 wj07 不存在")
    sys.exit(1)

print(f"✅ 用户: {user.username} (ID: {user.id})")

# 获取 CG 平台账号
cg_platform = db.query(AffiliatePlatform).filter(
    AffiliatePlatform.platform_name == "CG"
).first()

if not cg_platform:
    print("❌ 未找到 CG 平台")
    sys.exit(1)

cg_accounts = db.query(AffiliateAccount).filter(
    AffiliateAccount.user_id == user.id,
    AffiliateAccount.platform_id == cg_platform.id,
    AffiliateAccount.is_active == True
).all()

if not cg_accounts:
    print("❌ 用户没有 CG 平台账号")
    sys.exit(1)

print(f"\n找到 {len(cg_accounts)} 个 CG 账号")

# 日期范围
end_date = datetime.now()
begin_date = end_date - timedelta(days=7)

for account in cg_accounts[:1]:  # 只检查第一个账号
    print(f"\n{'='*50}")
    print(f"账号: {account.account_name}")
    
    # 从 notes 中获取 token
    token = None
    api_url = None
    if account.notes:
        try:
            notes_data = json.loads(account.notes)
            token = notes_data.get("collabglow_token") or notes_data.get("cg_token") or notes_data.get("api_token")
            api_url = notes_data.get("collabglow_api_url") or notes_data.get("cg_api_url") or notes_data.get("api_url")
        except:
            pass
    
    print(f"Token: {'已配置' if token else '❌ 未配置'}")
    print(f"API URL: {api_url or '使用默认'}")
    print(f"{'='*50}")
    
    if not token:
        print("❌ 未找到 API token，跳过")
        continue
    
    try:
        # 初始化服务
        service = CollabGlowService(
            token=token,
            base_url=api_url
        )
        
        # 调用 API
        print(f"\n📊 调用 CG API: {begin_date.strftime('%Y-%m-%d')} ~ {end_date.strftime('%Y-%m-%d')}")
        
        result = service.fetch_transactions(
            begin_date=begin_date.strftime("%Y-%m-%d"),
            end_date=end_date.strftime("%Y-%m-%d")
        )
        
        if not result or not result.get("data"):
            print("❌ API 返回空数据")
            continue
        
        transactions = result.get("data", [])
        print(f"📋 返回 {len(transactions)} 条交易\n")
        
        # 显示前3条的所有字段，特别关注可能是 MID 的字段
        shown = 0
        for item in transactions:
            if shown >= 5:
                break
            
            merchant_name = item.get("merchantName") or item.get("merchant_name") or item.get("merchant") or item.get("brand")
            
            # 只显示 TA3 商家的数据（这些是 MID 为 None 的）
            if "TA3" not in str(merchant_name):
                continue
            
            shown += 1
            print(f"=== TA3 交易 {shown} ===")
            
            # 显示所有可能是 MID 的字段
            mid_candidates = ['brandId', 'brand_id', 'mid', 'MID', 'merchant_id', 'merchantId', 
                            'mcid', 'MCID', 'm_id', 'advertiser_id', 'advertiserId', 'shop_id', 
                            'shopId', 'store_id', 'storeId', 'id', 'ID']
            
            print(f"  商家名: {merchant_name}")
            print(f"  🔍 可能的 MID 字段:")
            for field in mid_candidates:
                value = item.get(field)
                if value is not None:
                    print(f"     {field}: {value}")
            
            # 显示所有字段
            print(f"  📋 所有字段:")
            for key, value in item.items():
                print(f"     {key}: {value}")
            print()
        
        if shown == 0:
            print("未找到 TA3 商家的交易，显示前3条:")
            for idx, item in enumerate(transactions[:3]):
                print(f"\n=== 交易 {idx+1} ===")
                for key, value in item.items():
                    marker = "🔍 " if key.lower() in ['brandid', 'brand_id', 'mid', 'merchant_id', 'mcid'] else "   "
                    print(f"  {marker}{key}: {value}")
        
    except Exception as e:
        print(f"❌ 调用 API 失败: {e}")
        import traceback
        traceback.print_exc()

db.close()
print("\n诊断完成")

