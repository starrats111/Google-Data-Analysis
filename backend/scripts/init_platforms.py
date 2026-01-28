"""
初始化联盟平台数据
"""
import sys
import os

# 添加项目根目录到 Python 路径
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from sqlalchemy.orm import Session
from app.database import SessionLocal
from app.models.affiliate_account import AffiliatePlatform

def init_platforms():
    """初始化联盟平台数据"""
    db = SessionLocal()
    
    try:
        platforms_data = [
            {"platform_name": "Amazon Associates", "platform_code": "amazon", "description": "Amazon联盟平台"},
            {"platform_name": "Commission Junction", "platform_code": "cj", "description": "CJ联盟平台"},
            {"platform_name": "ShareASale", "platform_code": "shareasale", "description": "ShareASale联盟平台"},
            {"platform_name": "Rakuten", "platform_code": "rakuten", "description": "Rakuten联盟平台"},
            {"platform_name": "Impact", "platform_code": "impact", "description": "Impact联盟平台"},
            {"platform_name": "Awin", "platform_code": "awin", "description": "Awin联盟平台"},
        ]
        
        for platform_data in platforms_data:
            platform = db.query(AffiliatePlatform).filter(
                AffiliatePlatform.platform_code == platform_data["platform_code"]
            ).first()
            
            if not platform:
                platform = AffiliatePlatform(**platform_data)
                db.add(platform)
                print(f"创建平台：{platform_data['platform_name']}")
        
        db.commit()
        print("\n联盟平台初始化完成！")
        
    except Exception as e:
        db.rollback()
        print(f"初始化失败：{e}")
    finally:
        db.close()

if __name__ == "__main__":
    init_platforms()

