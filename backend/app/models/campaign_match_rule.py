"""
广告系列匹配规则模型
用于匹配谷歌广告系列名和平台账号
"""
from sqlalchemy import Column, Integer, String, DateTime, ForeignKey, Text, Boolean
from sqlalchemy.orm import relationship
from sqlalchemy.sql import func
from app.database import Base


class CampaignMatchRule(Base):
    """广告系列匹配规则"""
    __tablename__ = "campaign_match_rules"
    
    id = Column(Integer, primary_key=True, index=True)
    
    # 关联信息
    user_id = Column(Integer, ForeignKey("users.id", ondelete="CASCADE"), nullable=False, index=True)
    affiliate_account_id = Column(Integer, ForeignKey("affiliate_accounts.id", ondelete="CASCADE"), nullable=False, index=True)
    platform_id = Column(Integer, ForeignKey("affiliate_platforms.id"), nullable=False, index=True)
    
    # 匹配规则
    pattern = Column(String(255), nullable=False)  # 匹配模式（正则表达式或关键词）
    match_type = Column(String(20), default="contains", nullable=False)  # 匹配类型：contains, regex, prefix, suffix
    
    # 优先级（数字越大优先级越高）
    priority = Column(Integer, default=0, nullable=False)
    
    # 是否启用
    is_active = Column(Boolean, default=True, nullable=False)
    
    # 描述
    description = Column(Text, nullable=True)
    
    # 时间戳
    created_at = Column(DateTime(timezone=True), server_default=func.now())
    updated_at = Column(DateTime(timezone=True), onupdate=func.now())
    
    user = relationship("User")
    affiliate_account = relationship("AffiliateAccount")
    platform = relationship("AffiliatePlatform")


