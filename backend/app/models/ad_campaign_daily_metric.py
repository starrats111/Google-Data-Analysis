"""
广告系列每日指标模型

用于支持“每日表格分析”，并在“我的广告”中展示某广告系列某天的订单/预算/CPC等数据。
数据来源：每次分析(表1+表2)按 analysis_date 生成的逐广告系列结果行。
"""

from sqlalchemy import Column, Integer, Date, DateTime, ForeignKey, Float, UniqueConstraint, Index
from sqlalchemy.orm import relationship
from sqlalchemy.sql import func

from app.database import Base


class AdCampaignDailyMetric(Base):
    __tablename__ = "ad_campaign_daily_metrics"

    id = Column(Integer, primary_key=True, index=True)

    user_id = Column(Integer, ForeignKey("users.id", ondelete="CASCADE"), nullable=False, index=True)
    campaign_id = Column(Integer, ForeignKey("ad_campaigns.id", ondelete="CASCADE"), nullable=False, index=True)
    date = Column(Date, nullable=False, index=True)

    # 日指标（按广告系列）
    clicks = Column(Float, default=0.0, nullable=False)
    impressions = Column(Float, default=0.0, nullable=False)  # 展示次数（来自表1）
    orders = Column(Float, default=0.0, nullable=False)
    budget = Column(Float, default=0.0, nullable=False)
    cpc = Column(Float, default=0.0, nullable=False)
    cost = Column(Float, default=0.0, nullable=False)  # 费用（来自表1）
    commission = Column(Float, default=0.0, nullable=False)

    # 用于指令/7日分析的辅助字段（优先从表内拉取）
    past_seven_days_order_days = Column(Float, default=0.0, nullable=False)  # 过去七天出单天数
    current_max_cpc = Column(Float, default=0.0, nullable=False)  # 当前Max CPC（最高CPC）

    created_at = Column(DateTime(timezone=True), server_default=func.now())
    updated_at = Column(DateTime(timezone=True), onupdate=func.now())

    __table_args__ = (
        UniqueConstraint("campaign_id", "date", name="uq_campaign_daily_metric_campaign_date"),
        Index("idx_campaign_daily_metric_user_date", "user_id", "date"),
    )

    user = relationship("User")
    campaign = relationship("AdCampaign")



