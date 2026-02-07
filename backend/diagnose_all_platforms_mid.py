"""
诊断所有平台的 MID 字段
通过对比广告系列名中的 MID 和各平台 API 返回的 ID 字段，找到正确的 MID 字段名
"""
import sys
sys.path.insert(0, '.')

from datetime import date, timedelta
from app.database import SessionLocal
from app.models.user import User
from app.models.google_ads_api_data import GoogleAdsApiData
from app.models.affiliate_account import AffiliateAccount, AffiliatePlatform
from app.models.affiliate_transaction import AffiliateTransaction
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

print(f"\n📅 日期范围: {begin_date} ~ {end_date}")

# 1. 从广告系列名提取 MID
print("\n" + "="*70)
print("📊 步骤1: 从广告系列名提取 MID 和平台代码")
print("="*70)

google_ads = db.query(GoogleAdsApiData).filter(
    GoogleAdsApiData.user_id == user.id,
    GoogleAdsApiData.date >= begin_date,
    GoogleAdsApiData.date <= end_date
).all()

# 按平台分组提取 MID
# 格式: {platform_code: {mid: merchant_name}}
platform_mids = {}  # {platform: {mid: merchant}}

for ad in google_ads:
    parts = ad.campaign_name.split("-")
    mid = ""
    platform = ""
    merchant = ""
    
    # 提取平台代码（第2部分，索引1）
    if len(parts) >= 2:
        platform = parts[1].upper()
        # 标准化平台代码
        import re
        match = re.match(r'^([A-Z]+)\d*$', platform)
        if match:
            platform = match.group(1)
    
    # 提取商家名（第3部分，索引2）
    if len(parts) >= 3:
        merchant = parts[2].lower()
    
    # 提取 MID（最后的纯数字，5-6位以上）
    for p in reversed(parts):
        if p.isdigit() and len(p) >= 5:
            mid = p
            break
    
    if platform and mid:
        if platform not in platform_mids:
            platform_mids[platform] = {}
        if mid not in platform_mids[platform]:
            platform_mids[platform][mid] = merchant

# 显示各平台的 MID
for platform, mids in sorted(platform_mids.items()):
    print(f"\n平台 {platform}: 共 {len(mids)} 个 MID")
    for mid, merchant in list(mids.items())[:5]:  # 只显示前5个
        print(f"    MID={mid}, 商家={merchant}")
    if len(mids) > 5:
        print(f"    ... 还有 {len(mids) - 5} 个")

# 2. 检查交易数据中的 merchant_id
print("\n" + "="*70)
print("📊 步骤2: 检查交易数据中的 merchant_id")
print("="*70)

transactions = db.query(AffiliateTransaction).filter(
    AffiliateTransaction.user_id == user.id,
    AffiliateTransaction.transaction_time >= begin_date,
    AffiliateTransaction.transaction_time <= end_date
).all()

# 按平台分组
platform_txn = {}  # {platform: [{merchant_id, merchant, commission}]}
for txn in transactions:
    platform = txn.platform.upper() if txn.platform else "UNKNOWN"
    if platform not in platform_txn:
        platform_txn[platform] = []
    platform_txn[platform].append({
        "merchant_id": txn.merchant_id,
        "merchant": txn.merchant,
        "commission": float(txn.commission_amount or 0)
    })

for platform, txns in sorted(platform_txn.items()):
    print(f"\n平台 {platform}: 共 {len(txns)} 条交易")
    # 去重
    seen = set()
    for txn in txns[:10]:
        key = (txn['merchant_id'], txn['merchant'])
        if key in seen:
            continue
        seen.add(key)
        print(f"    merchant_id={txn['merchant_id']}, merchant={txn['merchant']}, commission={txn['commission']:.2f}")

# 3. 匹配分析
print("\n" + "="*70)
print("📊 步骤3: MID 匹配分析")
print("="*70)

for platform, mids in sorted(platform_mids.items()):
    print(f"\n🔍 平台 {platform}:")
    
    # 获取该平台的交易 merchant_id
    txn_mids = set()
    for txn in platform_txn.get(platform, []) + platform_txn.get(platform.lower(), []) + platform_txn.get("PARTNERMATIC" if platform == "PM" else platform, []):
        if txn.get('merchant_id') and txn['merchant_id'] != 'None':
            txn_mids.add(str(txn['merchant_id']))
    
    ad_mids = set(mids.keys())
    
    matched = ad_mids & txn_mids
    ad_only = ad_mids - txn_mids
    txn_only = txn_mids - ad_mids
    
    print(f"    广告系列 MID 数量: {len(ad_mids)}")
    print(f"    交易 merchant_id 数量: {len(txn_mids)}")
    print(f"    ✅ 匹配成功: {len(matched)} 个")
    
    if matched:
        for mid in list(matched)[:3]:
            print(f"        {mid} (商家: {mids.get(mid, '?')})")
    
    if ad_only and len(ad_only) <= 10:
        print(f"    ❌ 广告有但交易没有: {ad_only}")
    elif ad_only:
        print(f"    ❌ 广告有但交易没有: {len(ad_only)} 个")
    
    if txn_only and len(txn_only) <= 10:
        print(f"    ❌ 交易有但广告没有: {txn_only}")
    elif txn_only:
        print(f"    ❌ 交易有但广告没有: {len(txn_only)} 个")

db.close()
print("\n诊断完成")

