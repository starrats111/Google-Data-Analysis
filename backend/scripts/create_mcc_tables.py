#!/usr/bin/env python3
"""
创建MCC相关数据库表的脚本
"""
import sys
import os

# 添加项目路径
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from app.database import engine, Base
from app.models.mcc_account import MccAccount
from app.models.google_ads_daily_data import GoogleAdsDailyData
from app.models.platform_daily_data import PlatformDailyData
from app.models.campaign_match_rule import CampaignMatchRule

def create_tables():
    """创建所有新表"""
    print("=" * 60)
    print("创建MCC相关数据库表")
    print("=" * 60)
    print()
    
    try:
        # 创建所有表
        Base.metadata.create_all(bind=engine)
        print("✅ 所有表创建成功！")
        print()
        print("已创建的表：")
        print("  - mcc_accounts (MCC账号)")
        print("  - google_ads_daily_data (Google Ads每日数据)")
        print("  - platform_daily_data (平台每日数据)")
        print("  - campaign_match_rules (广告系列匹配规则)")
        print()
    except Exception as e:
        print(f"❌ 创建表失败: {e}")
        import traceback
        traceback.print_exc()
        return False
    
    return True

if __name__ == '__main__':
    create_tables()

