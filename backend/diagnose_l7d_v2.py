"""
诊断 L7D 佣金数据问题 - 查看所有平台
"""
import sys
sys.path.insert(0, '.')

from app.database import SessionLocal
from app.models.affiliate_account import AffiliatePlatform

db = SessionLocal()

print("📋 数据库中的所有平台:")
platforms = db.query(AffiliatePlatform).all()
for p in platforms:
    print(f"  ID={p.id}, code='{p.platform_code}', name='{p.platform_name}'")

db.close()

