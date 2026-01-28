"""
数据库迁移脚本：为数据上传表添加平台ID字段
用于支持谷歌广告数据按联盟平台分类
"""
import sys
import os

# 设置UTF-8编码输出
if sys.platform == 'win32':
    import codecs
    sys.stdout = codecs.getwriter('utf-8')(sys.stdout.buffer, 'strict')
    sys.stderr = codecs.getwriter('utf-8')(sys.stderr.buffer, 'strict')

# 添加项目根目录到 Python 路径
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from sqlalchemy import text
from app.database import engine

def migrate_add_platform_id():
    """为 data_uploads 表添加 platform_id 字段"""
    try:
        with engine.begin() as conn:  # 使用 begin() 自动提交事务
            # 检查字段是否已存在
            result = conn.execute(text("""
                SELECT COUNT(*) as cnt 
                FROM pragma_table_info('data_uploads') 
                WHERE name='platform_id'
            """))
            exists = result.fetchone()[0] > 0
            
            if exists:
                print("platform_id 字段已存在，跳过迁移")
                return
            
            # 添加 platform_id 字段
            print("正在添加 platform_id 字段到 data_uploads 表...")
            conn.execute(text("""
                ALTER TABLE data_uploads 
                ADD COLUMN platform_id INTEGER
            """))
            print("成功添加 platform_id 字段到 data_uploads 表")
            
            # 创建外键约束（SQLite 3.37.0+ 支持 ALTER TABLE ADD CONSTRAINT）
            # 但为了兼容性，我们只创建索引，外键关系在模型中定义
            try:
                conn.execute(text("""
                    CREATE INDEX IF NOT EXISTS ix_data_uploads_platform_id 
                    ON data_uploads(platform_id)
                """))
                print("成功创建 platform_id 字段索引")
            except Exception as e:
                print(f"创建索引时出现警告（可能已存在）: {e}")
            
            # 验证字段已添加
            result = conn.execute(text("""
                SELECT COUNT(*) as cnt 
                FROM pragma_table_info('data_uploads') 
                WHERE name='platform_id'
            """))
            if result.fetchone()[0] > 0:
                print("[成功] 迁移完成：platform_id 字段已成功添加到 data_uploads 表")
            else:
                print("[警告] 无法验证 platform_id 字段是否已添加")
                
    except Exception as e:
        print(f"迁移失败: {e}")
        import traceback
        traceback.print_exc()
        raise

if __name__ == "__main__":
    print("=" * 50)
    print("数据库迁移：添加 platform_id 字段")
    print("=" * 50)
    migrate_add_platform_id()
    print("=" * 50)

