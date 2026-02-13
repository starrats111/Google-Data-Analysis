"""
诊断 wj03 的 LinkHaiTao MID 154253 佣金同步问题
"""
import sys
sys.path.insert(0, '/home/admin/Google-Data-Analysis/backend')

from datetime import datetime, timedelta
from sqlalchemy import func
from app.database import SessionLocal
from app.models.user import User
from app.models.affiliate_account import AffiliateAccount, AffiliatePlatform
from app.models.affiliate_transaction import AffiliateTransaction

db = SessionLocal()

print("=" * 70)
print("诊断 wj03 的 LinkHaiTao MID 154253 佣金同步问题")
print("=" * 70)

# 1. 查找 wj03 用户
wj03 = db.query(User).filter(User.username == "wj03").first()
if not wj03:
    print("错误: 找不到 wj03 用户")
    sys.exit(1)

print(f"\n1. wj03 用户信息:")
print(f"   用户ID: {wj03.id}, 用户名: {wj03.username}, 角色: {wj03.role}")

# 2. 查找 wj03 的 LH 平台账号
print(f"\n2. wj03 的 LinkHaiTao 平台账号:")
lh_accounts = db.query(AffiliateAccount).join(AffiliatePlatform).filter(
    AffiliateAccount.user_id == wj03.id,
    AffiliatePlatform.platform_code.in_(["lh", "linkhaitao", "LH"])
).all()

if not lh_accounts:
    # 尝试其他方式查找
    all_accounts = db.query(AffiliateAccount).filter(
        AffiliateAccount.user_id == wj03.id
    ).all()
    print(f"   未找到 LH 账号，wj03 所有账号:")
    for acc in all_accounts:
        platform = db.query(AffiliatePlatform).filter(AffiliatePlatform.id == acc.platform_id).first()
        print(f"   - ID: {acc.id}, 名称: {acc.account_name}, 平台: {platform.platform_code if platform else 'N/A'}")
else:
    for acc in lh_accounts:
        platform = db.query(AffiliatePlatform).filter(AffiliatePlatform.id == acc.platform_id).first()
        print(f"   - ID: {acc.id}, 名称: {acc.account_name}, 平台: {platform.platform_code if platform else 'N/A'}")
        print(f"     备注: {acc.notes[:100] if acc.notes else 'N/A'}...")

# 3. 查找所有 LH 平台
print(f"\n3. 系统中的 LinkHaiTao 平台:")
lh_platforms = db.query(AffiliatePlatform).filter(
    AffiliatePlatform.platform_code.in_(["lh", "linkhaitao", "LH", "LinkHaiTao"])
).all()
for p in lh_platforms:
    print(f"   - ID: {p.id}, Code: {p.platform_code}, Name: {p.platform_name}")

# 4. 查找 wj03 的 LH 交易数据 (本月)
print(f"\n4. wj03 的 LH 交易数据 (2026-02-01 至 2026-02-12):")
begin_date = datetime(2026, 2, 1).date()
end_date = datetime(2026, 2, 12).date()

# 获取 wj03 的所有平台账号 ID
wj03_account_ids = [acc.id for acc in db.query(AffiliateAccount).filter(
    AffiliateAccount.user_id == wj03.id
).all()]

print(f"   wj03 账号 IDs: {wj03_account_ids}")

# 查找 LH 平台的交易
lh_platform = db.query(AffiliatePlatform).filter(
    AffiliatePlatform.platform_code == "lh"
).first()

# 方法1: 通过 platform 字段查找 (platform 是字符串，如 "lh", "LH", "LinkHaiTao")
lh_transactions = db.query(AffiliateTransaction).filter(
    AffiliateTransaction.affiliate_account_id.in_(wj03_account_ids),
    AffiliateTransaction.platform.in_(["lh", "LH", "LinkHaiTao", "linkhaitao"]),
    AffiliateTransaction.transaction_time >= begin_date,
    AffiliateTransaction.transaction_time <= end_date
).all()

print(f"   找到 {len(lh_transactions)} 条 LH 交易")
    
# 按商家分组统计
merchant_stats = {}
for t in lh_transactions:
    mid = t.merchant_id or "未知"
    if mid not in merchant_stats:
        merchant_stats[mid] = {"count": 0, "commission": 0}
    merchant_stats[mid]["count"] += 1
    merchant_stats[mid]["commission"] += float(t.commission_amount or 0)

print(f"\n   按商家(MID)统计:")
for mid, stats in sorted(merchant_stats.items()):
    print(f"   - MID {mid}: {stats['count']} 订单, ${stats['commission']:.2f} 佣金")

# 5. 特别检查 MID 154253
print(f"\n5. 特别检查 MID 154253 的交易:")
mid_154253_transactions = db.query(AffiliateTransaction).filter(
    AffiliateTransaction.affiliate_account_id.in_(wj03_account_ids),
    AffiliateTransaction.merchant_id == "154253",
    AffiliateTransaction.transaction_time >= begin_date,
    AffiliateTransaction.transaction_time <= end_date
).all()

print(f"   找到 {len(mid_154253_transactions)} 条 MID 154253 的交易")
if mid_154253_transactions:
    total_commission = sum(float(t.commission_amount or 0) for t in mid_154253_transactions)
    print(f"   总佣金: ${total_commission:.2f}")
    print(f"   最近5条交易:")
    for t in mid_154253_transactions[:5]:
        print(f"   - 日期: {t.transaction_time}, 订单: {t.transaction_id}, 佣金: ${t.commission_amount}, 状态: {t.status}")

# 6. 检查是否有其他用户的 MID 154253 数据
print(f"\n6. 检查系统中所有 MID 154253 的交易:")
all_mid_154253 = db.query(
    AffiliateTransaction.affiliate_account_id,
    func.count(AffiliateTransaction.id).label("count"),
    func.sum(AffiliateTransaction.commission_amount).label("total_commission")
).filter(
    AffiliateTransaction.merchant_id == "154253",
    AffiliateTransaction.transaction_time >= begin_date,
    AffiliateTransaction.transaction_time <= end_date
).group_by(AffiliateTransaction.affiliate_account_id).all()

for row in all_mid_154253:
    acc = db.query(AffiliateAccount).filter(AffiliateAccount.id == row.affiliate_account_id).first()
    user = db.query(User).filter(User.id == acc.user_id).first() if acc else None
    print(f"   账号ID: {row.affiliate_account_id}, 用户: {user.username if user else 'N/A'}, "
          f"订单数: {row.count}, 佣金: ${float(row.total_commission or 0):.2f}")

# 7. 检查 wj03 的 LH 账号最近同步时间
print(f"\n7. wj03 的 LH 账号同步状态:")
for acc_id in wj03_account_ids:
    acc = db.query(AffiliateAccount).filter(AffiliateAccount.id == acc_id).first()
    if acc:
        platform = db.query(AffiliatePlatform).filter(AffiliatePlatform.id == acc.platform_id).first()
        if platform and platform.platform_code.lower() in ["lh", "linkhaitao"]:
            print(f"   账号: {acc.account_name} (ID: {acc.id})")
            print(f"   最后同步: {acc.last_sync_at}")
            print(f"   同步状态: {acc.sync_status}")

db.close()
print("\n" + "=" * 70)
print("诊断完成!")
print("=" * 70)

