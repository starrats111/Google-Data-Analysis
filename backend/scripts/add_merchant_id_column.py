"""
迁移脚本：给 affiliate_transactions 表添加 merchant_id 列
用于存储平台商家ID(MID)，如 154253
"""
import sqlite3
import os
import sys

def migrate():
    db_path = os.path.join(os.path.dirname(os.path.dirname(__file__)), "google_analysis.db")
    
    if not os.path.exists(db_path):
        print(f"数据库文件不存在: {db_path}")
        sys.exit(1)
    
    conn = sqlite3.connect(db_path)
    cursor = conn.cursor()
    
    # 检查列是否已存在
    cursor.execute("PRAGMA table_info(affiliate_transactions)")
    columns = [col[1] for col in cursor.fetchall()]
    
    if "merchant_id" in columns:
        print("merchant_id 列已存在，跳过迁移")
    else:
        print("添加 merchant_id 列到 affiliate_transactions 表...")
        cursor.execute("ALTER TABLE affiliate_transactions ADD COLUMN merchant_id VARCHAR(32)")
        cursor.execute("CREATE INDEX IF NOT EXISTS idx_affiliate_transaction_merchant_id ON affiliate_transactions(merchant_id)")
        conn.commit()
        print("✅ merchant_id 列添加成功！")
    
    # 显示当前表结构
    cursor.execute("PRAGMA table_info(affiliate_transactions)")
    print("\n当前表结构:")
    for col in cursor.fetchall():
        print(f"  {col[1]} ({col[2]})")
    
    conn.close()

if __name__ == "__main__":
    migrate()

