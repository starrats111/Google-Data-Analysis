#!/usr/bin/env python
"""
强制重新同步 RW 平台数据，使用新的 MID 提取逻辑
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
print("强制重新同步 RW 平台数据")
print("=" * 70)

# 获取 RW 平台
rw_platform = db.query(AffiliatePlatform).filter(
    AffiliatePlatform.platform_name == "RW"
).first()

if not rw_platform:
    print("❌ 未找到 RW 平台")
    sys.exit(1)

# 删除 RW 平台的所有旧交易数据
deleted_count = db.query(AffiliateTransaction).filter(
    AffiliateTransaction.platform == "rw"
).delete()

db.commit()
print(f"✅ 已删除 {deleted_count} 条 RW 平台旧交易数据")

# 获取所有 RW 账号
rw_accounts = db.query(AffiliateAccount).filter(
    AffiliateAccount.platform_id == rw_platform.id,
    AffiliateAccount.is_active == True
).all()

print(f"📋 找到 {len(rw_accounts)} 个活跃 RW 账号")

# 导入同步服务
from app.services.platform_data_sync import PlatformDataSyncService

sync_service = PlatformDataSyncService(db)

for account in rw_accounts:
    user = db.query(User).filter(User.id == account.user_id).first()
    if not user:
        continue
    
    print(f"\n🔄 同步账号: {account.account_name} (用户: {user.username})")
    
    try:
        # 同步最近30天的数据
        result = sync_service.sync_rewardoo_transactions(
            account=account,
            start_date=datetime.now() - timedelta(days=30),
            end_date=datetime.now()
        )
        print(f"   ✅ 同步结果: {result}")
    except Exception as e:
        print(f"   ❌ 同步失败: {e}")

db.close()
print("\n" + "=" * 70)
print("重新同步完成！请再次运行 diagnose_all_platforms_mid.py 验证")
print("=" * 70)

