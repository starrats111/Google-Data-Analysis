"""
用户模型
"""
from sqlalchemy import Column, Integer, String, DateTime, Enum
from sqlalchemy.orm import relationship
from sqlalchemy.sql import func
from app.database import Base
import enum


class UserRole(str, enum.Enum):
    MANAGER = "manager"
    EMPLOYEE = "employee"


class User(Base):
    __tablename__ = "users"
    
    id = Column(Integer, primary_key=True, index=True)
    username = Column(String(50), unique=True, nullable=False, index=True)
    password_hash = Column(String(255), nullable=False)
    role = Column(Enum(UserRole), nullable=False)
    employee_id = Column(Integer, nullable=True)  # 1-10 for employees
    display_name = Column(String(50), nullable=True)  # 显示姓名（中文名）
    created_at = Column(DateTime(timezone=True), server_default=func.now())
    updated_at = Column(DateTime(timezone=True), onupdate=func.now())
    
    # 关系
    affiliate_accounts = relationship("AffiliateAccount", back_populates="user", cascade="all, delete-orphan")
    data_uploads = relationship("DataUpload", back_populates="user")
    analysis_results = relationship("AnalysisResult", back_populates="user")
    ad_campaigns = relationship("AdCampaign", back_populates="user", cascade="all, delete-orphan")
    expense_adjustments = relationship("ExpenseAdjustment", cascade="all, delete-orphan")
    mcc_accounts = relationship("GoogleMccAccount", back_populates="user", cascade="all, delete-orphan")
    platform_data = relationship("PlatformData", cascade="all, delete-orphan")
    google_ads_data = relationship("GoogleAdsApiData", cascade="all, delete-orphan")
    campaign_mappings = relationship("CampaignPlatformMapping", cascade="all, delete-orphan")








