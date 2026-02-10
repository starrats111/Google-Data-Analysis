"""
添加收款人和收款卡号字段到 affiliate_accounts 表
支持 PostgreSQL 和 SQLite
"""
import sys
import os
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from sqlalchemy import text, inspect
from app.database import SessionLocal, engine

def main():
    db = SessionLocal()
    try:
        # 使用 SQLAlchemy inspector 检查列是否存在
        inspector = inspect(engine)
        existing_columns = [col['name'] for col in inspector.get_columns('affiliate_accounts')]
        
        if 'payee_name' not in existing_columns:
            print("添加 payee_name 列...")
            db.execute(text("ALTER TABLE affiliate_accounts ADD COLUMN payee_name VARCHAR(100)"))
            print("  ✓ payee_name 添加成功")
        else:
            print("  payee_name 列已存在")
        
        if 'payee_card' not in existing_columns:
            print("添加 payee_card 列...")
            db.execute(text("ALTER TABLE affiliate_accounts ADD COLUMN payee_card VARCHAR(50)"))
            print("  ✓ payee_card 添加成功")
        else:
            print("  payee_card 列已存在")
        
        db.commit()
        print("\n完成！")
        
    except Exception as e:
        print(f"错误: {e}")
        db.rollback()
    finally:
        db.close()

if __name__ == "__main__":
    main()

