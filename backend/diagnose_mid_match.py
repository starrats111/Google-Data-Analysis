"""
诊断 MID 匹配问题
比较广告系列名中的 MID 和交易数据中的 merchant_id
"""
import sys
sys.path.insert(0, '.')

from datetime import date, timedelta
from app.database import SessionLocal
from app.models.user import User
from app.models.google_ads_api_data import GoogleAdsApiData
from app.models.affiliate_transaction import AffiliateTransaction

db = SessionLocal()

# 查找用户
user = db.query(User).filter(User.username == "wj02").first()
if not user:
    print("❌ 用户 wj02 不存在")
    sys.exit(1)

print(f"✅ 用户: {user.username} (ID: {user.id})")

# 获取 L7D 日期范围
end_date = date.today() - timedelta(days=1)
begin_date = end_date - timedelta(days=6)

print(f"\n📅 日期范围: {begin_date} ~ {end_date}")

# 1. 查看广告系列名及提取的 MID
print("\n" + "="*60)
print("📊 广告系列名及提取的 MID:")
print("="*60)

google_ads = db.query(GoogleAdsApiData).filter(
    GoogleAdsApiData.user_id == user.id,
    GoogleAdsApiData.date >= begin_date,
    GoogleAdsApiData.date <= end_date
).all()

campaign_mids = {}  # {campaign_name: extracted_mid}
for ad in google_ads:
    if ad.campaign_name not in campaign_mids:
        # 提取 MID（广告系列名最后的数字部分）
        parts = ad.campaign_name.split("-")
        mid = ""
        for p in reversed(parts):
            if p.isdigit() and len(p) >= 5:
                mid = p
                break
        campaign_mids[ad.campaign_name] = mid
        print(f"  广告系列: {ad.campaign_name}")
        print(f"    提取的 MID: {mid}")
        print()

# 2. 查看交易数据中的 merchant_id
print("\n" + "="*60)
print("💰 交易数据中的 merchant_id:")
print("="*60)

transactions = db.query(AffiliateTransaction).filter(
    AffiliateTransaction.user_id == user.id,
    AffiliateTransaction.transaction_time >= begin_date,
    AffiliateTransaction.transaction_time <= end_date
).all()

merchant_ids_in_txn = set()
for txn in transactions:
    print(f"  平台: {txn.platform}, 商家: {txn.merchant}")
    print(f"    merchant_id: {txn.merchant_id}")
    print(f"    佣金: {txn.commission_amount}")
    if txn.merchant_id:
        merchant_ids_in_txn.add(txn.merchant_id)
    print()

# 3. 检查匹配情况
print("\n" + "="*60)
print("🔍 匹配分析:")
print("="*60)

ad_mids = set(mid for mid in campaign_mids.values() if mid)
print(f"  广告系列中的 MID: {ad_mids}")
print(f"  交易中的 merchant_id: {merchant_ids_in_txn}")

# 检查交叉
matched = ad_mids & merchant_ids_in_txn
print(f"\n  ✅ 匹配的 MID: {matched if matched else '无'}")
print(f"  ❌ 广告系列有但交易没有: {ad_mids - merchant_ids_in_txn if ad_mids - merchant_ids_in_txn else '无'}")
print(f"  ❌ 交易有但广告系列没有: {merchant_ids_in_txn - ad_mids if merchant_ids_in_txn - ad_mids else '无'}")

db.close()
print("\n诊断完成")

