"""
为 ad_campaign_daily_metrics 表添加 impressions（展示次数）字段
"""
import sys
import os

# 添加项目根目录到路径
sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), '..')))

from app.database import engine
from sqlalchemy import text

def add_impressions_column():
    """添加 impressions 字段到 ad_campaign_daily_metrics 表"""
    with engine.connect() as conn:
        # 检查字段是否已存在
        result = conn.execute(text("""
            SELECT COUNT(*) as cnt 
            FROM pragma_table_info('ad_campaign_daily_metrics') 
            WHERE name = 'impressions'
        """))
        exists = result.fetchone()[0] > 0
        
        if exists:
            print("字段 'impressions' 已存在，跳过添加")
            return
        
        # 添加字段
        conn.execute(text("""
            ALTER TABLE ad_campaign_daily_metrics 
            ADD COLUMN impressions REAL DEFAULT 0.0 NOT NULL
        """))
        conn.commit()
        print("成功添加 'impressions' 字段到 ad_campaign_daily_metrics 表")

if __name__ == "__main__":
    add_impressions_column()

