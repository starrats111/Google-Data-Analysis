"""
数据库迁移脚本：为 GoogleMccAccount 表添加服务账号相关字段

运行方式：
cd backend
python -m scripts.migrate_mcc_service_account

此脚本会：
1. 添加 service_account_json 字段（服务账号JSON配置）
2. 添加 use_service_account 字段（是否使用服务账号模式）
3. 添加同步状态追踪字段
4. 将现有数据的 email 字段改为可选
"""
import sys
import os

# 将 backend 目录添加到路径
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from sqlalchemy import text, inspect
from app.database import engine, SessionLocal

def check_column_exists(table_name: str, column_name: str) -> bool:
    """检查列是否已存在"""
    inspector = inspect(engine)
    columns = [col['name'] for col in inspector.get_columns(table_name)]
    return column_name in columns

def run_migration():
    """执行数据库迁移"""
    db = SessionLocal()
    
    try:
        print("=" * 60)
        print("开始执行数据库迁移：添加服务账号相关字段")
        print("=" * 60)
        
        table_name = "google_mcc_accounts"
        
        # 检查表是否存在
        inspector = inspect(engine)
        if table_name not in inspector.get_table_names():
            print(f"表 {table_name} 不存在，跳过迁移")
            return
        
        # 新增字段列表
        new_columns = [
            ("service_account_json", "TEXT", None),
            ("use_service_account", "BOOLEAN", "1"),  # 默认为True
            ("last_sync_status", "VARCHAR(50)", None),
            ("last_sync_message", "TEXT", None),
            ("last_sync_at", "DATETIME", None),
            ("last_sync_date", "DATE", None),
            ("total_campaigns", "INTEGER", "0"),
            ("total_customers", "INTEGER", "0"),
        ]
        
        added_count = 0
        skipped_count = 0
        
        for column_name, column_type, default_value in new_columns:
            if check_column_exists(table_name, column_name):
                print(f"  ⏭️  列 {column_name} 已存在，跳过")
                skipped_count += 1
                continue
            
            # 构建 ALTER TABLE 语句
            if default_value is not None:
                sql = f"ALTER TABLE {table_name} ADD COLUMN {column_name} {column_type} DEFAULT {default_value}"
            else:
                sql = f"ALTER TABLE {table_name} ADD COLUMN {column_name} {column_type}"
            
            try:
                db.execute(text(sql))
                db.commit()
                print(f"  ✅ 添加列 {column_name} ({column_type})")
                added_count += 1
            except Exception as e:
                print(f"  ❌ 添加列 {column_name} 失败: {e}")
                db.rollback()
        
        # 修改 email 字段为可选（SQLite 不支持直接修改列约束，所以只打印提示）
        print("\n⚠️  注意：email 字段已在模型中改为可选，但 SQLite 不支持直接修改列约束")
        print("    新创建的记录将允许 email 为空")
        
        # 更新现有记录的 use_service_account 字段
        try:
            # 检查是否有需要更新的记录
            result = db.execute(text(f"SELECT COUNT(*) FROM {table_name} WHERE use_service_account IS NULL"))
            null_count = result.scalar()
            
            if null_count > 0:
                db.execute(text(f"UPDATE {table_name} SET use_service_account = 1 WHERE use_service_account IS NULL"))
                db.commit()
                print(f"\n✅ 已将 {null_count} 条记录的 use_service_account 设置为 True")
        except Exception as e:
            print(f"\n⚠️  更新 use_service_account 字段失败（可能已经有值）: {e}")
            db.rollback()
        
        print("\n" + "=" * 60)
        print(f"迁移完成！添加 {added_count} 列，跳过 {skipped_count} 列")
        print("=" * 60)
        
    except Exception as e:
        print(f"\n❌ 迁移失败: {e}")
        import traceback
        traceback.print_exc()
        db.rollback()
    finally:
        db.close()


def verify_migration():
    """验证迁移结果"""
    print("\n验证迁移结果...")
    
    inspector = inspect(engine)
    columns = inspector.get_columns("google_mcc_accounts")
    
    print("\ngoogle_mcc_accounts 表当前字段：")
    for col in columns:
        print(f"  - {col['name']}: {col['type']}")


if __name__ == "__main__":
    run_migration()
    verify_migration()

