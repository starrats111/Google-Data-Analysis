"""
数据库迁移脚本：为expense_adjustments表添加manual_cost字段
"""
import sys
import os

# 添加项目根目录到路径
sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), '..')))

from sqlalchemy import text
from app.database import SessionLocal
from app.config import settings

def migrate():
    """添加manual_cost字段到expense_adjustments表"""
    db = SessionLocal()
    try:
        # 检查字段是否已存在
        if settings.DATABASE_URL.startswith('sqlite'):
            # SQLite
            result = db.execute(text("""
                SELECT COUNT(*) as cnt 
                FROM pragma_table_info('expense_adjustments') 
                WHERE name = 'manual_cost'
            """))
            exists = result.scalar() > 0
        else:
            # PostgreSQL
            result = db.execute(text("""
                SELECT COUNT(*) as cnt 
                FROM information_schema.columns 
                WHERE table_name = 'expense_adjustments' 
                AND column_name = 'manual_cost'
            """))
            exists = result.scalar() > 0
        
        if exists:
            print("✓ manual_cost字段已存在，跳过迁移")
            return
        
        # 添加字段
        print("正在添加manual_cost字段...")
        if settings.DATABASE_URL.startswith('sqlite'):
            db.execute(text("""
                ALTER TABLE expense_adjustments 
                ADD COLUMN manual_cost REAL DEFAULT 0.0 NOT NULL
            """))
        else:
            db.execute(text("""
                ALTER TABLE expense_adjustments 
                ADD COLUMN manual_cost FLOAT DEFAULT 0.0 NOT NULL
            """))
        
        db.commit()
        print("✓ 成功添加manual_cost字段")
        
    except Exception as e:
        db.rollback()
        print(f"✗ 迁移失败: {e}")
        raise
    finally:
        db.close()

if __name__ == "__main__":
    migrate()

