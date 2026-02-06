"""
添加 customer_id 列到 google_ads_api_data 表
"""
import sqlite3
import os

def migrate():
    # 数据库路径
    db_path = os.path.join(os.path.dirname(os.path.dirname(__file__)), "google_analysis.db")
    
    if not os.path.exists(db_path):
        print(f"数据库不存在: {db_path}")
        return
    
    conn = sqlite3.connect(db_path)
    cursor = conn.cursor()
    
    try:
        # 检查 customer_id 列是否存在
        cursor.execute("PRAGMA table_info(google_ads_api_data)")
        columns = [col[1] for col in cursor.fetchall()]
        
        if "customer_id" not in columns:
            print("添加 customer_id 列...")
            cursor.execute("ALTER TABLE google_ads_api_data ADD COLUMN customer_id VARCHAR(20)")
            cursor.execute("CREATE INDEX IF NOT EXISTS idx_google_ads_api_data_customer_id ON google_ads_api_data(customer_id)")
            conn.commit()
            print("customer_id 列添加成功！")
        else:
            print("customer_id 列已存在，跳过")
        
    except Exception as e:
        print(f"迁移失败: {e}")
        conn.rollback()
    finally:
        conn.close()

if __name__ == "__main__":
    migrate()

