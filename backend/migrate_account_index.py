"""
添加 account_index 字段到 affiliate_accounts 表
用于区分同平台多账号，如 RW-1, RW-2
"""
import sqlite3
import os

def migrate():
    db_path = os.path.join(os.path.dirname(__file__), 'google_analysis.db')
    
    print("=" * 60)
    print("添加 account_index 字段迁移")
    print("=" * 60)
    print(f"数据库路径: {db_path}")
    
    conn = sqlite3.connect(db_path)
    cursor = conn.cursor()
    
    try:
        # 检查字段是否已存在
        cursor.execute("PRAGMA table_info(affiliate_accounts)")
        columns = [col[1] for col in cursor.fetchall()]
        
        if 'account_index' in columns:
            print("✓ account_index 字段已存在，无需迁移")
        else:
            # 添加字段
            cursor.execute("""
                ALTER TABLE affiliate_accounts 
                ADD COLUMN account_index INTEGER DEFAULT NULL
            """)
            conn.commit()
            print("✓ account_index 字段已添加")
        
        # 显示当前账号情况
        print("\n当前账号情况（同平台多账号）:")
        cursor.execute("""
            SELECT 
                u.username,
                p.platform_code,
                COUNT(*) as account_count
            FROM affiliate_accounts a
            JOIN users u ON a.user_id = u.id
            JOIN affiliate_platforms p ON a.platform_id = p.id
            WHERE a.is_active = 1
            GROUP BY u.username, p.platform_code
            HAVING COUNT(*) > 1
            ORDER BY u.username, p.platform_code
        """)
        
        results = cursor.fetchall()
        if results:
            for row in results:
                print(f"  {row[0]} - {row[1]}: {row[2]} 个账号")
        else:
            print("  暂无同平台多账号情况")
        
        print("\n迁移完成！")
        print("请在账号管理页面手动设置账号序号。")
        
    except Exception as e:
        print(f"迁移失败: {e}")
        conn.rollback()
        raise
    finally:
        conn.close()

if __name__ == "__main__":
    migrate()

