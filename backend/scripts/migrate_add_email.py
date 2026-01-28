"""
数据库迁移脚本：为联盟账号表添加邮箱字段
"""
import sys
import os

# 添加项目根目录到 Python 路径
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from sqlalchemy import text
from app.database import engine

def migrate_add_email():
    """为 affiliate_accounts 表添加 email 字段"""
    try:
        with engine.connect() as conn:
            # 检查字段是否已存在
            result = conn.execute(text("""
                SELECT COUNT(*) as cnt 
                FROM pragma_table_info('affiliate_accounts') 
                WHERE name='email'
            """))
            exists = result.fetchone()[0] > 0
            
            if exists:
                print("邮箱字段已存在，跳过迁移")
                return
            
            # 添加邮箱字段
            conn.execute(text("""
                ALTER TABLE affiliate_accounts 
                ADD COLUMN email VARCHAR(255)
            """))
            conn.commit()
            print("成功添加邮箱字段到 affiliate_accounts 表")
            
            # 创建索引
            try:
                conn.execute(text("""
                    CREATE INDEX IF NOT EXISTS ix_affiliate_accounts_email 
                    ON affiliate_accounts(email)
                """))
                conn.commit()
                print("成功创建邮箱字段索引")
            except Exception as e:
                print(f"创建索引时出现警告（可能已存在）: {e}")
                
    except Exception as e:
        print(f"迁移失败: {e}")
        import traceback
        traceback.print_exc()

if __name__ == "__main__":
    migrate_add_email()

