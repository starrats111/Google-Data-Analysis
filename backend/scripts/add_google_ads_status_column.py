"""
数据库迁移脚本：为google_ads_api_data表添加status字段
用于存储Google Ads广告系列的状态（已启用、已暂停、已移除等）
"""
import sys
import os

# 添加项目根目录到路径
sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), '..')))

from sqlalchemy import text
from app.database import engine

def add_status_column():
    """为google_ads_api_data表添加status字段"""
    try:
        with engine.begin() as conn:  # 使用begin()自动提交事务
            # 检查字段是否已存在
            result = conn.execute(text("""
                SELECT COUNT(*) as cnt 
                FROM pragma_table_info('google_ads_api_data') 
                WHERE name='status'
            """))
            exists = result.fetchone()[0] > 0
            
            if exists:
                print("status字段已存在，跳过迁移")
                return
            
            # 添加status字段
            print("正在添加status字段到google_ads_api_data表...")
            conn.execute(text("""
                ALTER TABLE google_ads_api_data 
                ADD COLUMN status VARCHAR(50)
            """))
            print("成功添加status字段到google_ads_api_data表")
            
            # 验证字段已添加
            result = conn.execute(text("""
                SELECT COUNT(*) as cnt 
                FROM pragma_table_info('google_ads_api_data') 
                WHERE name='status'
            """))
            if result.fetchone()[0] > 0:
                print("[成功] 迁移完成：status字段已成功添加到google_ads_api_data表")
            else:
                print("[警告] 无法验证status字段是否已添加")
                
    except Exception as e:
        print(f"迁移失败: {e}")
        import traceback
        traceback.print_exc()
        raise

if __name__ == "__main__":
    print("=" * 50)
    print("数据库迁移：添加status字段")
    print("=" * 50)
    add_status_column()
    print("=" * 50)

