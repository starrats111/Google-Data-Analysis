"""
数据库迁移脚本：为expense_adjustments表添加manual_commission字段，并创建mcc_cost_adjustments表
"""
import sys
import os

# 添加项目根目录到路径
sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), '..')))

from sqlalchemy import text
from app.database import SessionLocal
from app.config import settings

def migrate():
    """添加manual_commission字段和创建mcc_cost_adjustments表"""
    db = SessionLocal()
    try:
        # 1. 检查manual_commission字段是否已存在
        if settings.DATABASE_URL.startswith('sqlite'):
            # SQLite
            result = db.execute(text("""
                SELECT COUNT(*) as cnt 
                FROM pragma_table_info('expense_adjustments') 
                WHERE name = 'manual_commission'
            """))
            exists = result.scalar() > 0
        else:
            # PostgreSQL
            result = db.execute(text("""
                SELECT COUNT(*) as cnt 
                FROM information_schema.columns 
                WHERE table_name = 'expense_adjustments' 
                AND column_name = 'manual_commission'
            """))
            exists = result.scalar() > 0
        
        if not exists:
            # 添加字段
            print("正在添加manual_commission字段...")
            if settings.DATABASE_URL.startswith('sqlite'):
                db.execute(text("""
                    ALTER TABLE expense_adjustments 
                    ADD COLUMN manual_commission REAL DEFAULT 0.0 NOT NULL
                """))
            else:
                db.execute(text("""
                    ALTER TABLE expense_adjustments 
                    ADD COLUMN manual_commission FLOAT DEFAULT 0.0 NOT NULL
                """))
            db.commit()
            print("✓ 成功添加manual_commission字段")
        else:
            print("✓ manual_commission字段已存在，跳过")
        
        # 2. 检查mcc_cost_adjustments表是否已存在
        if settings.DATABASE_URL.startswith('sqlite'):
            result = db.execute(text("""
                SELECT COUNT(*) as cnt 
                FROM sqlite_master 
                WHERE type='table' AND name='mcc_cost_adjustments'
            """))
            table_exists = result.scalar() > 0
        else:
            result = db.execute(text("""
                SELECT COUNT(*) as cnt 
                FROM information_schema.tables 
                WHERE table_name = 'mcc_cost_adjustments'
            """))
            table_exists = result.scalar() > 0
        
        if not table_exists:
            # 创建表
            print("正在创建mcc_cost_adjustments表...")
            if settings.DATABASE_URL.startswith('sqlite'):
                db.execute(text("""
                    CREATE TABLE mcc_cost_adjustments (
                        id INTEGER PRIMARY KEY AUTOINCREMENT,
                        user_id INTEGER NOT NULL,
                        mcc_id INTEGER NOT NULL,
                        date DATE NOT NULL,
                        manual_cost REAL DEFAULT 0.0 NOT NULL,
                        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                        updated_at TIMESTAMP,
                        UNIQUE(user_id, mcc_id, date),
                        FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
                        FOREIGN KEY (mcc_id) REFERENCES google_mcc_accounts(id) ON DELETE CASCADE
                    )
                """))
                db.execute(text("""
                    CREATE INDEX idx_mcc_cost_adj_user ON mcc_cost_adjustments(user_id)
                """))
                db.execute(text("""
                    CREATE INDEX idx_mcc_cost_adj_mcc ON mcc_cost_adjustments(mcc_id)
                """))
                db.execute(text("""
                    CREATE INDEX idx_mcc_cost_adj_date ON mcc_cost_adjustments(date)
                """))
            else:
                db.execute(text("""
                    CREATE TABLE mcc_cost_adjustments (
                        id SERIAL PRIMARY KEY,
                        user_id INTEGER NOT NULL,
                        mcc_id INTEGER NOT NULL,
                        date DATE NOT NULL,
                        manual_cost FLOAT DEFAULT 0.0 NOT NULL,
                        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                        updated_at TIMESTAMP,
                        UNIQUE(user_id, mcc_id, date),
                        FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
                        FOREIGN KEY (mcc_id) REFERENCES google_mcc_accounts(id) ON DELETE CASCADE
                    )
                """))
                db.execute(text("""
                    CREATE INDEX idx_mcc_cost_adj_user ON mcc_cost_adjustments(user_id)
                """))
                db.execute(text("""
                    CREATE INDEX idx_mcc_cost_adj_mcc ON mcc_cost_adjustments(mcc_id)
                """))
                db.execute(text("""
                    CREATE INDEX idx_mcc_cost_adj_date ON mcc_cost_adjustments(date)
                """))
            db.commit()
            print("✓ 成功创建mcc_cost_adjustments表")
        else:
            print("✓ mcc_cost_adjustments表已存在，跳过")
        
    except Exception as e:
        db.rollback()
        print(f"✗ 迁移失败: {e}")
        raise
    finally:
        db.close()

if __name__ == "__main__":
    migrate()

