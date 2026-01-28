"""
创建广告系列表
"""
import sys
from pathlib import Path

# 添加项目根目录到路径
project_root = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(project_root))

from app.database import Base, engine
from app.models.ad_campaign import AdCampaign

def create_table():
    """创建广告系列表"""
    try:
        # 创建表
        AdCampaign.__table__.create(bind=engine, checkfirst=True)
        print("广告系列表创建成功")
    except Exception as e:
        print(f"创建表失败: {e}")

if __name__ == "__main__":
    create_table()

