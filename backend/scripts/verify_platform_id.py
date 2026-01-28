"""
验证 platform_id 字段是否已添加到 data_uploads 表
"""
import sys
import os

# 添加项目根目录到 Python 路径
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

# 设置UTF-8编码输出
if sys.platform == 'win32':
    import codecs
    sys.stdout = codecs.getwriter('utf-8')(sys.stdout.buffer, 'strict')
    sys.stderr = codecs.getwriter('utf-8')(sys.stderr.buffer, 'strict')

from sqlalchemy import text
from app.database import engine

def verify_platform_id():
    """验证 platform_id 字段是否存在"""
    try:
        with engine.connect() as conn:
            # 获取所有列名
            result = conn.execute(text("""
                SELECT name, type, "notnull", dflt_value 
                FROM pragma_table_info('data_uploads') 
                ORDER BY cid
            """))
            columns = result.fetchall()
            
            print("=" * 60)
            print("data_uploads 表结构：")
            print("=" * 60)
            platform_id_exists = False
            for col in columns:
                col_name, col_type, notnull, dflt_value = col
                nullable = "NULL" if notnull == 0 else "NOT NULL"
                default = f" DEFAULT {dflt_value}" if dflt_value else ""
                print(f"  {col_name:25} {col_type:15} {nullable}{default}")
                if col_name == 'platform_id':
                    platform_id_exists = True
            
            print("=" * 60)
            if platform_id_exists:
                print("[成功] platform_id 字段已存在")
            else:
                print("[失败] platform_id 字段不存在，请运行迁移脚本")
            print("=" * 60)
            
            # 检查索引
            result = conn.execute(text("""
                SELECT name FROM sqlite_master 
                WHERE type='index' AND tbl_name='data_uploads' 
                AND name LIKE '%platform_id%'
            """))
            indexes = result.fetchall()
            if indexes:
                print("\n相关索引：")
                for idx in indexes:
                    print(f"  - {idx[0]}")
            else:
                print("\n[警告] 未找到 platform_id 相关索引")
                
    except Exception as e:
        print(f"验证失败: {e}")
        import traceback
        traceback.print_exc()

if __name__ == "__main__":
    verify_platform_id()

