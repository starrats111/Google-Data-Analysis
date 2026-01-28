"""
初始化数据库
"""
import sys
import os

# 添加项目根目录到 Python 路径
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from app.database import engine, Base
from app.models import User, AffiliatePlatform, AffiliateAccount, DataUpload, AnalysisResult

def init_db():
    """创建所有表"""
    Base.metadata.create_all(bind=engine)
    print("数据库表创建完成！")

if __name__ == "__main__":
    init_db()

