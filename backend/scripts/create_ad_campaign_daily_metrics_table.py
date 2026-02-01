"""
创建广告系列每日指标表
用于老库增量创建（SQLite 直接 create_all 即可补表）。
"""
import sys
import os

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from app.database import engine, Base
from app.models import AdCampaignDailyMetric  # noqa: F401


def run():
    Base.metadata.create_all(bind=engine)
    print("ad_campaign_daily_metrics 表已确保存在！")


if __name__ == "__main__":
    run()






