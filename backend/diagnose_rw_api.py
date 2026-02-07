#!/usr/bin/env python
"""
诊断 RW 平台 API 返回的原始字段
找到正确的 MID 字段
"""
import sys
sys.path.insert(0, '.')

from datetime import datetime, timedelta
from app.database import SessionLocal
from app.models.user import User
from app.models.affiliate_account import AffiliatePlatform, AffiliateAccount
from app.services.rewardoo_service import RewardooService

db = SessionLocal()

print("=" * 70)
print("诊断 RW 平台 API 返回的原始字段")
print("=" * 70)

# 获取用户
user = db.query(User).filter(User.username == "wj07").first()
if not user:
    print("❌ 用户 wj07 不存在")
    sys.exit(1)

print(f"✅ 用户: {user.username} (ID: {user.id})")

# 获取 RW 平台账号
rw_platform = db.query(AffiliatePlatform).filter(
    AffiliatePlatform.platform_name == "RW"
).first()

if not rw_platform:
    print("❌ 未找到 RW 平台")
    sys.exit(1)

rw_accounts = db.query(AffiliateAccount).filter(
    AffiliateAccount.user_id == user.id,
    AffiliateAccount.platform_id == rw_platform.id,
    AffiliateAccount.is_active == True
).all()

if not rw_accounts:
    print("❌ 用户没有 RW 平台账号")
    sys.exit(1)

print(f"\n找到 {len(rw_accounts)} 个 RW 账号")

# 日期范围
end_date = datetime.now()
begin_date = end_date - timedelta(days=7)

for account in rw_accounts[:1]:  # 只检查第一个账号
    print(f"\n{'='*50}")
    print(f"账号: {account.account_name}")
    print(f"Token 前20位: {account.api_token[:20] if account.api_token else 'N/A'}...")
    print(f"{'='*50}")
    
    try:
        # 初始化服务
        service = RewardooService(
            token=account.api_token,
            base_url=account.api_url
        )
        
        # 获取交易数据
        result = service.get_transactions(
            begin_date.strftime("%Y-%m-%d"),
            end_date.strftime("%Y-%m-%d")
        )
        
        if result.get("code") != "0":
            print(f"❌ API 返回错误: {result.get('message')}")
            continue
        
        transactions = result.get("data", {}).get("transactions", [])
        print(f"\n📊 返回 {len(transactions)} 条交易")
        
        # 显示前3条交易的所有字段
        for idx, tx in enumerate(transactions[:3]):
            print(f"\n=== 交易 {idx + 1} ===")
            
            # 显示所有字段
            for key, value in tx.items():
                # 高亮可能是 MID 的字段
                if any(k in key.lower() for k in ['id', 'mid', 'mcid', 'brand', 'merchant']):
                    print(f"  🔍 {key}: {value}")
                else:
                    print(f"     {key}: {value}")
            
    except Exception as e:
        print(f"❌ 错误: {e}")
        import traceback
        traceback.print_exc()

db.close()
print("\n诊断完成")

