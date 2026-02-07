"""
诊断 PM 平台 API 返回的原始数据字段
"""
import sys
sys.path.insert(0, '.')

from datetime import date, timedelta
from app.database import SessionLocal
from app.models.user import User
from app.models.affiliate_account import AffiliateAccount, AffiliatePlatform
from app.services.partnermatic_service import PartnerMaticService
import json

db = SessionLocal()

# 查找 wj02 用户
user = db.query(User).filter(User.username == "wj02").first()
if not user:
    print("❌ 用户 wj02 不存在")
    sys.exit(1)

print(f"✅ 用户: {user.username} (ID: {user.id})")

# 查找 PM 平台账号
pm_platform = db.query(AffiliatePlatform).filter(
    AffiliatePlatform.platform_name == "PM"
).first()

if not pm_platform:
    print("❌ PM 平台不存在")
    sys.exit(1)

pm_account = db.query(AffiliateAccount).filter(
    AffiliateAccount.user_id == user.id,
    AffiliateAccount.platform_id == pm_platform.id,
    AffiliateAccount.is_active == True
).first()

if not pm_account:
    print("❌ 用户没有 PM 平台账号")
    sys.exit(1)

# 从 notes 获取 token
token = None
if pm_account.notes:
    try:
        notes_data = json.loads(pm_account.notes)
        token = notes_data.get("partnermatic_token") or notes_data.get("pm_token") or notes_data.get("api_token") or notes_data.get("token")
    except:
        # notes 可能是纯文本 token
        token = pm_account.notes.strip()

if not token:
    print("❌ 未找到 PM Token")
    print(f"  账号 notes: {pm_account.notes}")
    sys.exit(1)

print(f"✅ PM 账号: {pm_account.account_name}")
print(f"  Token 前20位: {token[:20]}...")

# 调用 PM API 获取原始数据
end_date = date.today() - timedelta(days=1)
begin_date = end_date - timedelta(days=6)

print(f"\n📊 调用 PM API: {begin_date} ~ {end_date}")

try:
    service = PartnerMaticService(token)
    result = service._get_transactions_paginated(
        begin_date.strftime("%Y-%m-%d"),
        end_date.strftime("%Y-%m-%d"),
        page=1,
        per_page=5  # 只取5条
    )
    
    if result.get("success"):
        transactions = result.get("data", {}).get("list", [])
        print(f"\n📋 返回 {len(transactions)} 条交易:")
        
        for i, tx in enumerate(transactions[:3]):  # 只显示前3条
            print(f"\n=== 交易 {i+1} ===")
            for key, value in tx.items():
                print(f"  {key}: {value}")
    else:
        print(f"❌ API 调用失败: {result.get('message')}")
        
except Exception as e:
    import traceback
    print(f"❌ 异常: {e}")
    traceback.print_exc()

db.close()
print("\n诊断完成")

