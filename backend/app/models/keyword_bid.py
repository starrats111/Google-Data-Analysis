"""
关键词出价数据模型
存储从 Google Ads API 获取的关键词级别 CPC 出价数据
"""
from sqlalchemy import Column, Integer, String, Float, DateTime, ForeignKey, Text, Boolean
from sqlalchemy.orm import relationship

from app.database import Base
from app.middleware.auth import utc_now


class KeywordBid(Base):
    """关键词出价表"""
    __tablename__ = "keyword_bids"
    
    id = Column(Integer, primary_key=True, index=True)
    user_id = Column(Integer, ForeignKey("users.id"), nullable=False)
    mcc_id = Column(Integer, ForeignKey("google_mcc_accounts.id"), nullable=False)
    customer_id = Column(String(50), nullable=False)  # Google Ads 客户账号ID (CID)
    campaign_id = Column(String(50), nullable=False)
    campaign_name = Column(String(255))
    ad_group_id = Column(String(50))
    ad_group_name = Column(String(255))
    criterion_id = Column(String(50))  # 关键词 criterion ID
    keyword_text = Column(String(255))  # 关键词文本
    match_type = Column(String(20))     # EXACT, PHRASE, BROAD
    max_cpc = Column(Float)             # 最高CPC出价（标准单位，如美元/人民币）
    effective_cpc = Column(Float)       # 有效CPC出价
    avg_cpc = Column(Float)             # 平均CPC（用于计算建议值）
    status = Column(String(20))         # ENABLED, PAUSED, REMOVED
    quality_score = Column(Integer)     # 质量得分 1-10
    last_sync_at = Column(DateTime, default=utc_now)
    created_at = Column(DateTime, default=utc_now)
    updated_at = Column(DateTime, default=utc_now, onupdate=utc_now)
    
    # 关系
    user = relationship("User", backref="keyword_bids")
    mcc = relationship("GoogleMccAccount", backref="keyword_bids")


class CampaignBidStrategy(Base):
    """广告系列出价策略表"""
    __tablename__ = "campaign_bid_strategies"
    
    id = Column(Integer, primary_key=True, index=True)
    user_id = Column(Integer, ForeignKey("users.id"), nullable=False)
    mcc_id = Column(Integer, ForeignKey("google_mcc_accounts.id"), nullable=False)
    customer_id = Column(String(50), nullable=False)
    campaign_id = Column(String(50), nullable=False)
    campaign_name = Column(String(255))
    
    # 出价策略信息
    bidding_strategy_type = Column(String(50))  # MANUAL_CPC, MAXIMIZE_CLICKS, TARGET_CPA, etc.
    bidding_strategy_name = Column(String(100)) # 中文名称
    is_manual_cpc = Column(Boolean, default=False)  # 是否为人工CPC出价
    enhanced_cpc_enabled = Column(Boolean, default=False)  # 是否启用智能点击付费
    
    # 统计数据
    max_cpc_limit = Column(Float)  # 出价上限（如果设置）
    avg_cpc = Column(Float)        # 平均CPC
    
    last_sync_at = Column(DateTime, default=utc_now)
    created_at = Column(DateTime, default=utc_now)
    updated_at = Column(DateTime, default=utc_now, onupdate=utc_now)
    
    # 关系
    user = relationship("User", backref="campaign_bid_strategies")
    mcc = relationship("GoogleMccAccount", backref="campaign_bid_strategies")


class BidStrategyChange(Base):
    """出价策略变更记录"""
    __tablename__ = "bid_strategy_changes"
    
    id = Column(Integer, primary_key=True, index=True)
    user_id = Column(Integer, ForeignKey("users.id"), nullable=False)
    mcc_id = Column(Integer, nullable=False)
    customer_id = Column(String(50), nullable=False)
    campaign_id = Column(String(50), nullable=False)
    campaign_name = Column(String(255))
    
    old_strategy = Column(String(50))   # 原策略类型
    new_strategy = Column(String(50))   # 新策略类型（通常是 MANUAL_CPC）
    status = Column(String(20), default='pending')  # pending, success, failed
    error_message = Column(Text)
    
    created_at = Column(DateTime, default=utc_now)
    completed_at = Column(DateTime)
    
    # 关系
    user = relationship("User", backref="bid_strategy_changes")


