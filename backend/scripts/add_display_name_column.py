"""
添加 display_name 列到 users 表
并初始化员工的显示姓名
"""
import sys
import os
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from sqlalchemy import text
from app.database import SessionLocal, engine

db = SessionLocal()

# 员工姓名对照表
EMPLOYEE_NAMES = {
    'wj01': '吴含雪',
    'wj02': '朱于森',
    'wj03': '梅雯慧',
    'wj04': '齐满艳',
    'wj05': '陈正深',
    'wj06': '齐青青',
    'wj07': '朱文欣',
    'wj08': '8号机',
    'wj09': '胡雪茜',
    'wj10': '蓝晨馨',
}

try:
    # 1. 检查列是否已存在
    result = db.execute(text("PRAGMA table_info(users)"))
    columns = [row[1] for row in result.fetchall()]
    
    if 'display_name' not in columns:
        print("添加 display_name 列...")
        db.execute(text("ALTER TABLE users ADD COLUMN display_name VARCHAR(50)"))
        db.commit()
        print("  ✓ 列添加成功")
    else:
        print("display_name 列已存在")
    
    # 2. 初始化员工姓名
    print("\n初始化员工显示姓名...")
    for username, display_name in EMPLOYEE_NAMES.items():
        db.execute(
            text("UPDATE users SET display_name = :name WHERE username = :username"),
            {"name": display_name, "username": username}
        )
        print(f"  ✓ {username} -> {display_name}")
    
    db.commit()
    print("\n完成！")
    
    # 3. 验证
    print("\n验证结果:")
    result = db.execute(text("SELECT username, display_name FROM users WHERE role = 'employee' ORDER BY username"))
    for row in result.fetchall():
        print(f"  {row[0]}: {row[1]}")

except Exception as e:
    print(f"错误: {e}")
    db.rollback()
finally:
    db.close()

