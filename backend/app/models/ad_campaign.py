"""
广告系列数据模型
"""
from sqlalchemy import Column, Integer, String, Boolean, ForeignKey, DateTime, Date, Text, Index
from sqlalchemy.orm import relationship
from sqlalchemy.sql import func
from app.database import Base


class AdCampaign(Base):
    """广告系列模型"""
    __tablename__ = "ad_campaigns"
    
    id = Column(Integer, primary_key=True, index=True)
    user_id = Column(Integer, ForeignKey("users.id", ondelete="CASCADE"), nullable=False, index=True)
    affiliate_account_id = Column(Integer, ForeignKey("affiliate_accounts.id", ondelete="CASCADE"), nullable=False, index=True)
    platform_id = Column(Integer, ForeignKey("affiliate_platforms.id"), nullable=False, index=True)
    
    # 广告系列基本信息
    cid_account = Column(String(100), nullable=True, index=True)  # CID账号
    url = Column(Text, nullable=True)  # 网址
    merchant_id = Column(String(50), nullable=False, index=True)  # 商家ID
    country = Column(String(10), nullable=True)  # 国家
    campaign_name = Column(String(255), nullable=False, index=True)  # 广告系列名称
    ad_time = Column(String(50), nullable=True)  # 广告时间
    keywords = Column(Text, nullable=True)  # 关键词
    
    # 状态管理
    status = Column(String(20), default="启用", nullable=False, index=True)  # 状态：启用/暂停
    
    # 时间戳
    created_at = Column(DateTime(timezone=True), server_default=func.now())
    updated_at = Column(DateTime(timezone=True), onupdate=func.now())
    
    # 索引：用于搜索
    __table_args__ = (
        Index('idx_merchant_campaign', 'merchant_id', 'campaign_name'),
        Index('idx_user_platform', 'user_id', 'platform_id'),
    )
    
    # 关系
    user = relationship("User", back_populates="ad_campaigns")
    affiliate_account = relationship("AffiliateAccount")
    platform = relationship("AffiliatePlatform")

