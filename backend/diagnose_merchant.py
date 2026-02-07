"""
诊断商家数据匹配问题
"""
import sys
sys.path.insert(0, '.')

from datetime import date, timedelta
from app.database import SessionLocal
from app.models.user import User
from app.models.affiliate_transaction import AffiliateTransaction
from app.models.google_ads_api_data import GoogleAdsApiData
from sqlalchemy import func

db = SessionLocal()

# 查找 wj02 用户
user = db.query(User).filter(User.username == "wj02").first()
if not user:
    print("❌ 用户 wj02 不存在")
    sys.exit(1)

print(f"✅ 用户: {user.username} (ID: {user.id})")

end_date = date.today() - timedelta(days=1)
begin_date = end_date - timedelta(days=6)
print(f"\n📊 L7D 日期范围: {begin_date} ~ {end_date}")

# 检查 AffiliateTransaction 表中的商家数据
print(f"\n📋 AffiliateTransaction 表中的商家数据 (前20条):")
transactions = db.query(
    AffiliateTransaction.merchant_id,
    AffiliateTransaction.merchant,
    AffiliateTransaction.platform,
    func.sum(AffiliateTransaction.commission_amount).label('total_commission'),
    func.count(AffiliateTransaction.id).label('total_orders')
).filter(
    AffiliateTransaction.user_id == user.id,
    func.date(AffiliateTransaction.transaction_time) >= begin_date,
    func.date(AffiliateTransaction.transaction_time) <= end_date
).group_by(
    AffiliateTransaction.merchant_id,
    AffiliateTransaction.merchant,
    AffiliateTransaction.platform
).limit(20).all()

for txn in transactions:
    print(f"  MID='{txn.merchant_id}', 商家='{txn.merchant}', 平台={txn.platform}, 佣金=${txn.total_commission:.2f}, 订单={txn.total_orders}")

# 检查 Google Ads 数据中的 MID
print(f"\n📈 Google Ads 数据中的 MID (从广告系列名提取):")
google_data = db.query(GoogleAdsApiData.campaign_name).filter(
    GoogleAdsApiData.user_id == user.id,
    GoogleAdsApiData.date >= begin_date,
    GoogleAdsApiData.date <= end_date
).distinct().limit(10).all()

import re
for gd in google_data:
    campaign_name = gd.campaign_name
    # 从广告系列名提取 MID（最后一个数字部分）
    parts = campaign_name.split('-')
    mid = parts[-1] if parts and parts[-1].isdigit() else "N/A"
    print(f"  广告系列: {campaign_name}")
    print(f"    提取的 MID: {mid}")

db.close()
print("\n诊断完成")

