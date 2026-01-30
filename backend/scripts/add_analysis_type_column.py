#!/usr/bin/env python3
"""
为analysis_results表添加analysis_type列的迁移脚本
"""
import sys
from pathlib import Path

# 添加项目根目录到路径
project_root = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(project_root))

from sqlalchemy import text
from app.database import engine

def add_analysis_type_column():
    """添加analysis_type列"""
    print("开始添加analysis_type列...")
    
    try:
        with engine.connect() as conn:
            # 检查列是否已存在
            result = conn.execute(text("""
                SELECT COUNT(*) FROM pragma_table_info('analysis_results') 
                WHERE name='analysis_type'
            """))
            
            if result.scalar() == 0:
                # 添加列
                conn.execute(text("""
                    ALTER TABLE analysis_results 
                    ADD COLUMN analysis_type VARCHAR(20) DEFAULT 'l7d' NOT NULL
                """))
                conn.commit()
                print("✓ analysis_type列添加成功")
            else:
                print("✓ analysis_type列已存在，跳过")
            
            # 创建索引
            try:
                conn.execute(text("""
                    CREATE INDEX IF NOT EXISTS idx_analysis_results_type 
                    ON analysis_results(analysis_type)
                """))
                conn.commit()
                print("✓ 索引创建成功")
            except Exception as e:
                print(f"⚠ 索引创建失败（可能已存在）: {e}")
        
        return True
        
    except Exception as e:
        print(f"✗ 添加列失败: {e}")
        import traceback
        traceback.print_exc()
        return False

if __name__ == "__main__":
    success = add_analysis_type_column()
    sys.exit(0 if success else 1)


