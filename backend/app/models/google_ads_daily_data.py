"""
谷歌广告每日数据模型
从Google Ads API自动获取的数据
"""
from sqlalchemy import Column, Integer, String, Date, DateTime, Float, ForeignKey, UniqueConstraint, Index, Text
from sqlalchemy.orm import relationship
from sqlalchemy.sql import func
from app.database import Base


class GoogleAdsDailyData(Base):
    """谷歌广告每日数据"""
    __tablename__ = "google_ads_daily_data"
    
    id = Column(Integer, primary_key=True, index=True)
    
    # 关联信息
    user_id = Column(Integer, ForeignKey("users.id", ondelete="CASCADE"), nullable=False, index=True)
    mcc_account_id = Column(String(100), nullable=True, index=True)  # MCC账号ID
    customer_id = Column(String(100), nullable=True, index=True)  # 客户ID（CID）
    campaign_id = Column(String(100), nullable=False, index=True)  # 广告系列ID
    campaign_name = Column(String(255), nullable=False, index=True)  # 广告系列名称
    
    # 日期
    date = Column(Date, nullable=False, index=True)
    
    # 谷歌广告数据
    budget = Column(Float, default=0.0, nullable=False)  # 预算
    cost = Column(Float, default=0.0, nullable=False)  # 费用
    impressions = Column(Float, default=0.0, nullable=False)  # 展示
    clicks = Column(Float, default=0.0, nullable=False)  # 点击
    cpc = Column(Float, default=0.0, nullable=False)  # CPC
    is_budget_lost = Column(Float, default=0.0, nullable=False)  # IS Budget丢失
    is_rank_lost = Column(Float, default=0.0, nullable=False)  # IS Rank丢失
    
    # 元数据
    created_at = Column(DateTime(timezone=True), server_default=func.now())
    updated_at = Column(DateTime(timezone=True), onupdate=func.now())
    
    __table_args__ = (
        UniqueConstraint("campaign_id", "date", name="uq_google_ads_daily_campaign_date"),
        Index("idx_google_ads_daily_user_date", "user_id", "date"),
        Index("idx_google_ads_daily_campaign_name", "campaign_name"),
    )
    
    user = relationship("User")


