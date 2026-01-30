"""
谷歌广告API数据模型
存储从Google Ads API同步的数据
"""
from sqlalchemy import Column, Integer, String, Date, DateTime, ForeignKey, Float, Text, UniqueConstraint, Index
from sqlalchemy.orm import relationship
from sqlalchemy.sql import func
from app.database import Base


class GoogleAdsApiData(Base):
    """谷歌广告API数据模型"""
    __tablename__ = "google_ads_api_data"
    
    id = Column(Integer, primary_key=True, index=True)
    
    # 关联信息
    mcc_id = Column(Integer, ForeignKey("google_mcc_accounts.id", ondelete="CASCADE"), nullable=False, index=True)
    user_id = Column(Integer, ForeignKey("users.id", ondelete="CASCADE"), nullable=False, index=True)
    campaign_id = Column(String(100), nullable=False, index=True)  # Google Ads Campaign ID
    campaign_name = Column(String(255), nullable=False, index=True)  # 广告系列名称
    date = Column(Date, nullable=False, index=True)
    
    # 提取的平台信息（从广告系列名中提取）
    extracted_platform_code = Column(String(50), nullable=True, index=True)  # 从广告系列名提取的平台代码
    extracted_account_code = Column(String(50), nullable=True, index=True)  # 从广告系列名提取的账号代码
    
    # 谷歌广告数据
    budget = Column(Float, default=0.0, nullable=False)  # 预算
    cost = Column(Float, default=0.0, nullable=False)  # 费用
    impressions = Column(Float, default=0.0, nullable=False)  # 展示
    clicks = Column(Float, default=0.0, nullable=False)  # 点击
    cpc = Column(Float, default=0.0, nullable=False)  # CPC
    is_budget_lost = Column(Float, default=0.0, nullable=False)  # IS Budget丢失
    is_rank_lost = Column(Float, default=0.0, nullable=False)  # IS Rank丢失
    
    # 元数据
    last_sync_at = Column(DateTime(timezone=True), server_default=func.now())  # 最后同步时间
    created_at = Column(DateTime(timezone=True), server_default=func.now())
    updated_at = Column(DateTime(timezone=True), onupdate=func.now())
    
    __table_args__ = (
        UniqueConstraint("mcc_id", "campaign_id", "date", name="uq_google_ads_api_data_mcc_campaign_date"),
        Index("idx_google_ads_api_data_user_date", "user_id", "date"),
        Index("idx_google_ads_api_data_platform_date", "extracted_platform_code", "date"),
        Index("idx_google_ads_api_data_campaign_date", "campaign_id", "date"),
    )
    
    mcc_account = relationship("GoogleMccAccount", back_populates="google_ads_data")
    user = relationship("User")


class GoogleMccAccount(Base):
    """Google MCC账号模型"""
    __tablename__ = "google_mcc_accounts"
    
    id = Column(Integer, primary_key=True, index=True)
    
    # 关联信息
    user_id = Column(Integer, ForeignKey("users.id", ondelete="CASCADE"), nullable=False, index=True)
    
    # MCC信息
    mcc_id = Column(String(100), nullable=False, unique=True, index=True)  # Google MCC ID
    mcc_name = Column(String(255), nullable=False)  # MCC名称
    email = Column(String(255), nullable=False, index=True)  # 关联的邮箱
    
    # API配置
    refresh_token = Column(Text, nullable=True)  # OAuth刷新token
    access_token = Column(Text, nullable=True)  # 当前访问token
    client_id = Column(String(255), nullable=True)
    client_secret = Column(Text, nullable=True)
    
    # 状态
    is_active = Column(Boolean, default=True, nullable=False, index=True)
    
    # 元数据
    created_at = Column(DateTime(timezone=True), server_default=func.now())
    updated_at = Column(DateTime(timezone=True), onupdate=func.now())
    
    user = relationship("User", back_populates="mcc_accounts")
    google_ads_data = relationship("GoogleAdsApiData", back_populates="mcc_account")


class CampaignPlatformMapping(Base):
    """广告系列与平台匹配规则模型"""
    __tablename__ = "campaign_platform_mappings"
    
    id = Column(Integer, primary_key=True, index=True)
    
    # 匹配规则
    user_id = Column(Integer, ForeignKey("users.id", ondelete="CASCADE"), nullable=False, index=True)
    platform_code = Column(String(50), nullable=False, index=True)  # 平台代码
    account_code = Column(String(50), nullable=True, index=True)  # 账号代码（可选）
    
    # 匹配模式（支持正则表达式）
    campaign_name_pattern = Column(String(255), nullable=False)  # 广告系列名匹配模式
    
    # 优先级（数字越大优先级越高）
    priority = Column(Integer, default=0, nullable=False)
    
    # 状态
    is_active = Column(Boolean, default=True, nullable=False)
    
    # 元数据
    created_at = Column(DateTime(timezone=True), server_default=func.now())
    updated_at = Column(DateTime(timezone=True), onupdate=func.now())
    
    user = relationship("User")


