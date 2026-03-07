"""
删除 wj02 名下错误的 January Import 交易

原因：import_jan_data.py 从 Excel 导入时，对所有记录使用了占位符商家名 "January Import"。
wj02 在 LH 平台实际不拥有该商家，但被错误导入到其数据中心。
"""
import sys
import os
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from app.database import SessionLocal
from app.models.user import User
from app.models.affiliate_transaction import AffiliateTransaction

db = SessionLocal()

wj02 = db.query(User).filter(User.username == 'wj02').first()
if not wj02:
    print("wj02 用户不存在")
    sys.exit(1)

# 删除 wj02 名下 January Import 且来自 JAN2026 导入的交易
deleted = db.query(AffiliateTransaction).filter(
    AffiliateTransaction.user_id == wj02.id,
    AffiliateTransaction.merchant == 'January Import',
    AffiliateTransaction.transaction_id.like('JAN2026-%')
).delete(synchronize_session=False)

db.commit()
print(f"已删除 wj02 名下 {deleted} 条错误的 January Import 交易")
db.close()
