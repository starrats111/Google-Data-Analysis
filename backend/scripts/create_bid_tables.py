"""
创建出价管理相关的数据库表
"""
import sys
import os
sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), '..')))

from sqlalchemy import inspect
from app.database import engine, SessionLocal
from app.models.keyword_bid import KeywordBid, CampaignBidStrategy, BidStrategyChange


def create_tables():
    print("=" * 60)
    print("创建出价管理数据库表")
    print("=" * 60)
    
    inspector = inspect(engine)
    existing_tables = inspector.get_table_names()
    
    tables_to_create = [
        ('keyword_bids', KeywordBid),
        ('campaign_bid_strategies', CampaignBidStrategy),
        ('bid_strategy_changes', BidStrategyChange),
    ]
    
    for table_name, model in tables_to_create:
        if table_name in existing_tables:
            print(f"  ✓ 表 {table_name} 已存在，跳过")
        else:
            print(f"  创建表 {table_name}...")
            try:
                model.__table__.create(engine)
                print(f"  ✓ 表 {table_name} 创建成功")
            except Exception as e:
                print(f"  ✗ 表 {table_name} 创建失败: {e}")
    
    print("\n完成！")


if __name__ == "__main__":
    create_tables()

