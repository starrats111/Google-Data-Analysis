"""
诊断：通过对比广告系列名中的 MID 和 API 返回的各种 ID 字段，找到正确的 MID 字段名
"""
import sys
sys.path.insert(0, '.')

from datetime import date, timedelta
from app.database import SessionLocal
from app.models.user import User
from app.models.google_ads_api_data import GoogleAdsApiData
from app.models.affiliate_account import AffiliateAccount, AffiliatePlatform
from app.services.partnermatic_service import PartnerMaticService
import json

db = SessionLocal()

# 查找用户
user = db.query(User).filter(User.username == "wj02").first()
if not user:
    print("❌ 用户 wj02 不存在")
    sys.exit(1)

print(f"✅ 用户: {user.username} (ID: {user.id})")

# 获取日期范围
end_date = date.today() - timedelta(days=1)
begin_date = end_date - timedelta(days=6)

# 1. 提取广告系列名中的 MID
print("\n" + "="*70)
print("📊 步骤1: 从广告系列名提取 MID")
print("="*70)

google_ads = db.query(GoogleAdsApiData).filter(
    GoogleAdsApiData.user_id == user.id,
    GoogleAdsApiData.date >= begin_date,
    GoogleAdsApiData.date <= end_date
).all()

# 提取所有广告系列的 MID 和商家名
campaign_info = {}  # {mid: {"campaigns": [...], "merchant": ...}}
for ad in google_ads:
    parts = ad.campaign_name.split("-")
    mid = ""
    merchant = ""
    
    # 提取 MID（最后的纯数字，5-6位）
    for p in reversed(parts):
        if p.isdigit() and len(p) >= 5:
            mid = p
            break
    
    # 提取商家名（第3个部分，索引2）
    if len(parts) >= 3:
        merchant = parts[2].lower()
    
    if mid and mid not in campaign_info:
        campaign_info[mid] = {
            "campaigns": [],
            "merchant": merchant
        }
    if mid:
        if ad.campaign_name not in campaign_info[mid]["campaigns"]:
            campaign_info[mid]["campaigns"].append(ad.campaign_name)

print(f"  找到 {len(campaign_info)} 个不同的 MID:")
for mid, info in campaign_info.items():
    print(f"    MID: {mid}, 商家: {info['merchant']}, 广告系列数: {len(info['campaigns'])}")

# 2. 获取 PM API 数据
print("\n" + "="*70)
print("📊 步骤2: 获取 PM API 交易数据")
print("="*70)

pm_platform = db.query(AffiliatePlatform).filter(
    AffiliatePlatform.platform_name == "PM"
).first()

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
        token = pm_account.notes.strip()

if not token:
    print("❌ 未找到 PM Token")
    sys.exit(1)

service = PartnerMaticService(token)
result = service._get_transactions_paginated(
    begin_date.strftime("%Y-%m-%d"),
    end_date.strftime("%Y-%m-%d"),
    page=1,
    per_page=100
)

if not result.get("success"):
    print(f"❌ API 调用失败: {result.get('message')}")
    sys.exit(1)

transactions = result.get("data", {}).get("list", [])
print(f"  获取到 {len(transactions)} 条交易")

# 3. 对比所有 ID 字段，找匹配
print("\n" + "="*70)
print("📊 步骤3: 对比广告系列 MID 和 API 中的 ID 字段")
print("="*70)

# 收集所有可能的 ID 字段
id_fields = ['brand_id', 'norm_id', 'mcid', 'partnermatic_id', 'order_id', 'channel_id']

for mid, info in campaign_info.items():
    merchant_name = info['merchant']
    print(f"\n🔍 查找 MID={mid}, 商家={merchant_name}:")
    
    for tx in transactions:
        tx_merchant = (tx.get('merchant_name') or tx.get('merchantName') or '').lower()
        
        # 检查每个可能的 ID 字段
        for field in id_fields:
            field_value = tx.get(field)
            if field_value is not None:
                field_value_str = str(field_value)
                
                # 检查是否匹配 MID
                if field_value_str == mid:
                    # 同时检查商家名模糊匹配
                    merchant_match = merchant_name in tx_merchant or tx_merchant in merchant_name
                    
                    status = "✅ 匹配" if merchant_match else "⚠️ MID匹配但商家名不匹配"
                    print(f"    {status}: {field}={field_value_str}, 交易商家={tx_merchant}")
                    
                    if merchant_match:
                        print(f"    🎉 找到！PM 的 MID 字段是: {field}")

print("\n" + "="*70)
print("📊 步骤4: 显示 PM 交易中的所有数字 ID 字段（供参考）")
print("="*70)

# 显示前5条交易的所有ID字段
for i, tx in enumerate(transactions[:5]):
    print(f"\n交易 {i+1}: {tx.get('merchant_name', 'N/A')}")
    for field in id_fields:
        print(f"    {field}: {tx.get(field)}")

db.close()
print("\n诊断完成")

