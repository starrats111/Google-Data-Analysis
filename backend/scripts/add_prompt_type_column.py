#!/usr/bin/env python3
"""
数据库迁移脚本：给 user_prompts 表添加 prompt_type 列
"""
import sys
import os

# 添加项目根目录到 Python 路径
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from sqlalchemy import text, inspect
from app.database import engine, SessionLocal

def migrate():
    """添加 prompt_type 列到 user_prompts 表"""
    db = SessionLocal()
    
    try:
        # 使用 Inspector 检查列是否存在（跨数据库兼容）
        inspector = inspect(engine)
        columns = [col['name'] for col in inspector.get_columns('user_prompts')]
        
        if 'prompt_type' in columns:
            print("prompt_type 列已存在，跳过")
        else:
            print("添加 prompt_type 列...")
            with engine.connect() as conn:
                # 添加列（默认值为 'analysis'）
                conn.execute(text(
                    "ALTER TABLE user_prompts ADD COLUMN prompt_type VARCHAR(20) DEFAULT 'analysis'"
                ))
                conn.commit()
            print("  ✓ prompt_type 列添加成功")
        
        # 移除 user_id 的 unique 约束（如果存在）
        # 注意：SQLite 不支持直接删除约束，需要重建表
        # 这里只打印提示，实际操作需要根据数据库类型处理
        print("\n注意：如果 user_id 有 unique 约束，需要手动处理")
        print("现在每个用户可以有两条记录：一条 analysis，一条 report")
        
        print("\n完成！")
        
    except Exception as e:
        print(f"错误: {e}")
        raise
    finally:
        db.close()

if __name__ == "__main__":
    migrate()

