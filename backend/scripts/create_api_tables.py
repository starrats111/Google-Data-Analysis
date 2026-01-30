#!/usr/bin/env python3
"""
创建API数据相关表的迁移脚本
"""
import sys
from pathlib import Path

# 添加项目根目录到路径
project_root = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(project_root))

from app.database import engine, Base
from app.models.platform_data import PlatformData
from app.models.google_ads_api_data import GoogleAdsApiData, GoogleMccAccount, CampaignPlatformMapping
from app.models.user import User

def create_tables():
    """创建所有新表"""
    print("开始创建API数据相关表...")
    
    try:
        # 创建所有表
        Base.metadata.create_all(bind=engine)
        print("✓ 表创建成功")
        print("\n已创建的表：")
        print("  - platform_data (平台数据表)")
        print("  - google_ads_api_data (Google Ads API数据表)")
        print("  - google_mcc_accounts (Google MCC账号表)")
        print("  - campaign_platform_mappings (广告系列匹配规则表)")
        
    except Exception as e:
        print(f"✗ 创建表失败: {e}")
        import traceback
        traceback.print_exc()
        return False
    
    return True

if __name__ == "__main__":
    success = create_tables()
    sys.exit(0 if success else 1)


