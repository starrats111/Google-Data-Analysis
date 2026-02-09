#!/usr/bin/env python3
"""
添加性能优化索引脚本
用于优化数据库查询速度
"""
import sys
import os

# 添加项目根目录到路径
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from sqlalchemy import create_engine, text
from app.config import settings

def add_indexes():
    """添加性能优化索引"""
    engine = create_engine(settings.DATABASE_URL, echo=True)
    
    # 定义需要添加的索引
    indexes = [
        # Google Ads API 数据表索引
        ("idx_google_ads_api_data_user_mcc_date", 
         "google_ads_api_data", 
         "user_id, mcc_id, date"),
        
        ("idx_google_ads_api_data_status_date", 
         "google_ads_api_data", 
         "status, date"),
        
        ("idx_google_ads_api_data_mcc_campaign_status", 
         "google_ads_api_data", 
         "mcc_id, campaign_id, status"),
        
        # 联盟交易表索引
        ("idx_affiliate_transaction_user_platform_time", 
         "affiliate_transactions", 
         "user_id, platform, transaction_time"),
        
        ("idx_affiliate_transaction_account_time", 
         "affiliate_transactions", 
         "affiliate_account_id, transaction_time"),
        
        ("idx_affiliate_transaction_merchant_time", 
         "affiliate_transactions", 
         "merchant_id, transaction_time"),
        
        # 分析结果表索引
        ("idx_analysis_results_user_type_date", 
         "analysis_results", 
         "user_id, analysis_type, analysis_date DESC"),
        
        ("idx_analysis_results_account_date", 
         "analysis_results", 
         "affiliate_account_id, analysis_date DESC"),
        
        # MCC账号表索引
        ("idx_mcc_accounts_user_active", 
         "google_mcc_accounts", 
         "user_id, is_active"),
    ]
    
    with engine.connect() as conn:
        for index_name, table_name, columns in indexes:
            try:
                # 先检查索引是否存在（SQLite）
                check_sql = text(f"""
                    SELECT name FROM sqlite_master 
                    WHERE type='index' AND name='{index_name}'
                """)
                result = conn.execute(check_sql).fetchone()
                
                if result:
                    print(f"✓ 索引 {index_name} 已存在，跳过")
                    continue
                
                # 创建索引
                create_sql = text(f"""
                    CREATE INDEX IF NOT EXISTS {index_name} 
                    ON {table_name} ({columns})
                """)
                conn.execute(create_sql)
                conn.commit()
                print(f"✓ 成功创建索引: {index_name}")
                
            except Exception as e:
                print(f"✗ 创建索引 {index_name} 失败: {e}")
                continue
    
    print("\n索引添加完成！")

if __name__ == "__main__":
    print("=" * 60)
    print("添加性能优化索引")
    print("=" * 60)
    add_indexes()

