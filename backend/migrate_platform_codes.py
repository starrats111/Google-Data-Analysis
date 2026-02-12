"""
数据库迁移脚本：统一平台代码为小写缩写

将以下平台代码从全称改为小写缩写：
- linkhaitao -> lh
- partnerboost -> pb
- linkbux -> lb
- partnermatic -> pm
- brandsparkhub -> bsh
- creatorflare -> cf

注意：cg 和 rw 已经是小写缩写，不需要修改

使用方法：
    python migrate_platform_codes.py [--dry-run] [--verbose]
    
参数：
    --dry-run   仅显示将要修改的内容，不实际执行
    --verbose   显示详细日志
"""
import os
import sys
import sqlite3
import argparse
from datetime import datetime

# 配置
DATABASE_PATH = os.path.join(os.path.dirname(__file__), 'google_analysis.db')

# 平台代码映射（旧 -> 新）
PLATFORM_CODE_MIGRATION = {
    'linkhaitao': 'lh',
    'partnerboost': 'pb',
    'linkbux': 'lb',
    'partnermatic': 'pm',
    'brandsparkhub': 'bsh',
    'creatorflare': 'cf',
}


def get_database_connection():
    """获取数据库连接"""
    if not os.path.exists(DATABASE_PATH):
        print(f"错误：数据库文件不存在: {DATABASE_PATH}")
        sys.exit(1)
    
    conn = sqlite3.connect(DATABASE_PATH)
    conn.row_factory = sqlite3.Row
    return conn


def count_records_to_migrate(conn, table_name, column_name):
    """统计需要迁移的记录数"""
    cursor = conn.cursor()
    counts = {}
    
    for old_code in PLATFORM_CODE_MIGRATION.keys():
        cursor.execute(f"SELECT COUNT(*) FROM {table_name} WHERE {column_name} = ?", (old_code,))
        count = cursor.fetchone()[0]
        if count > 0:
            counts[old_code] = count
    
    return counts


def migrate_table(conn, table_name, column_name, dry_run=False, verbose=False):
    """迁移单个表的平台代码"""
    cursor = conn.cursor()
    
    print(f"\n{'='*60}")
    print(f"处理表: {table_name}.{column_name}")
    print(f"{'='*60}")
    
    # 统计当前数据
    counts = count_records_to_migrate(conn, table_name, column_name)
    
    if not counts:
        print("  没有需要迁移的记录")
        return 0
    
    total_migrated = 0
    
    for old_code, count in counts.items():
        new_code = PLATFORM_CODE_MIGRATION[old_code]
        print(f"  {old_code} -> {new_code}: {count} 条记录")
        
        if verbose:
            # 显示一些示例记录
            cursor.execute(f"SELECT * FROM {table_name} WHERE {column_name} = ? LIMIT 3", (old_code,))
            rows = cursor.fetchall()
            for row in rows:
                print(f"    示例: {dict(row)}")
        
        if not dry_run:
            cursor.execute(
                f"UPDATE {table_name} SET {column_name} = ? WHERE {column_name} = ?",
                (new_code, old_code)
            )
            affected = cursor.rowcount
            print(f"    已更新 {affected} 条记录")
            total_migrated += affected
        else:
            total_migrated += count
    
    return total_migrated


def main():
    parser = argparse.ArgumentParser(description='迁移数据库平台代码为小写缩写')
    parser.add_argument('--dry-run', action='store_true', help='仅显示将要修改的内容，不实际执行')
    parser.add_argument('--verbose', action='store_true', help='显示详细日志')
    args = parser.parse_args()
    
    print("="*60)
    print("平台代码迁移脚本")
    print("="*60)
    print(f"数据库路径: {DATABASE_PATH}")
    print(f"运行模式: {'DRY RUN (不实际修改)' if args.dry_run else '正式执行'}")
    print(f"迁移映射:")
    for old, new in PLATFORM_CODE_MIGRATION.items():
        print(f"  {old} -> {new}")
    print()
    
    conn = get_database_connection()
    
    try:
        # 需要迁移的表和字段
        tables_to_migrate = [
            ('affiliate_transactions', 'platform'),
            ('affiliate_platforms', 'platform_code'),
            ('analysis_results', 'platform'),
        ]
        
        total_all = 0
        
        for table_name, column_name in tables_to_migrate:
            try:
                migrated = migrate_table(conn, table_name, column_name, args.dry_run, args.verbose)
                total_all += migrated
            except sqlite3.OperationalError as e:
                if "no such table" in str(e).lower():
                    print(f"\n  表 {table_name} 不存在，跳过")
                elif "no such column" in str(e).lower():
                    print(f"\n  列 {table_name}.{column_name} 不存在，跳过")
                else:
                    raise
        
        print(f"\n{'='*60}")
        print(f"迁移总结")
        print(f"{'='*60}")
        print(f"总计影响记录数: {total_all}")
        
        if not args.dry_run:
            # 提交更改
            conn.commit()
            print(f"数据库已更新！")
            
            # 创建备份记录
            backup_file = f"migration_backup_{datetime.now().strftime('%Y%m%d_%H%M%S')}.log"
            with open(backup_file, 'w', encoding='utf-8') as f:
                f.write(f"迁移时间: {datetime.now()}\n")
                f.write(f"数据库: {DATABASE_PATH}\n")
                f.write(f"迁移映射:\n")
                for old, new in PLATFORM_CODE_MIGRATION.items():
                    f.write(f"  {old} -> {new}\n")
                f.write(f"总计影响记录数: {total_all}\n")
            print(f"迁移日志已保存到: {backup_file}")
        else:
            print("(DRY RUN 模式，未实际修改数据库)")
        
    except Exception as e:
        print(f"\n错误: {e}")
        conn.rollback()
        sys.exit(1)
    finally:
        conn.close()
    
    print("\n完成！")


if __name__ == '__main__':
    main()

