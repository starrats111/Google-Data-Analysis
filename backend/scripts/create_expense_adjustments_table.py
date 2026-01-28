"""
创建 expense_adjustments 表
"""
import sys
from pathlib import Path

project_root = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(project_root))

from app.database import engine
from app.models.expense_adjustment import ExpenseAdjustment


def create_table():
    try:
        ExpenseAdjustment.__table__.create(bind=engine, checkfirst=True)
        print("expense_adjustments 表创建成功")
    except Exception as e:
        print(f"创建表失败: {e}")


if __name__ == "__main__":
    create_table()


