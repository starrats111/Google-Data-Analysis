"""
联盟账号数据模型
"""
from sqlalchemy import Column, Integer, String, Boolean, Text, ForeignKey, DateTime, UniqueConstraint
from sqlalchemy.orm import relationship
from sqlalchemy.sql import func
from app.database import Base


class AffiliatePlatform(Base):
    """联盟平台模型"""
    __tablename__ = "affiliate_platforms"
    
    id = Column(Integer, primary_key=True, index=True)
    platform_name = Column(String(100), unique=True, nullable=False, index=True)
    platform_code = Column(String(50), unique=True, nullable=False)
    description = Column(Text, nullable=True)
    created_at = Column(DateTime(timezone=True), server_default=func.now())
    
    # 关系
    accounts = relationship("AffiliateAccount", back_populates="platform")


class AffiliateAccount(Base):
    """联盟账号模型"""
    __tablename__ = "affiliate_accounts"
    
    id = Column(Integer, primary_key=True, index=True)
    user_id = Column(Integer, ForeignKey("users.id", ondelete="CASCADE"), nullable=False, index=True)
    platform_id = Column(Integer, ForeignKey("affiliate_platforms.id"), nullable=False, index=True)
    account_name = Column(String(100), nullable=False)
    account_code = Column(String(50), nullable=True)
    email = Column(String(255), nullable=True, index=True)  # 邮箱地址
    is_active = Column(Boolean, default=True, nullable=False, index=True)
    notes = Column(Text, nullable=True)
    created_at = Column(DateTime(timezone=True), server_default=func.now())
    updated_at = Column(DateTime(timezone=True), onupdate=func.now())
    
    # 唯一约束：同一员工在同一平台不能有重复账号名
    __table_args__ = (
        UniqueConstraint('user_id', 'platform_id', 'account_name', name='uq_user_platform_account'),
    )
    
    # 关系
    user = relationship("User", back_populates="affiliate_accounts")
    platform = relationship("AffiliatePlatform", back_populates="accounts")
    data_uploads = relationship("DataUpload", back_populates="affiliate_account")
    analysis_results = relationship("AnalysisResult", back_populates="affiliate_account")




