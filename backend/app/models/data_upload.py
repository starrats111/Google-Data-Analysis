"""
数据上传模型
"""
from sqlalchemy import Column, Integer, String, Date, DateTime, ForeignKey, Enum
from sqlalchemy.orm import relationship
from sqlalchemy.sql import func
from app.database import Base
import enum


class UploadType(str, enum.Enum):
    GOOGLE_ADS = "google_ads"
    AFFILIATE = "affiliate"


class UploadStatus(str, enum.Enum):
    PENDING = "pending"
    PROCESSING = "processing"
    COMPLETED = "completed"
    FAILED = "failed"


class DataUpload(Base):
    __tablename__ = "data_uploads"
    
    id = Column(Integer, primary_key=True, index=True)
    user_id = Column(Integer, ForeignKey("users.id"), nullable=False, index=True)
    affiliate_account_id = Column(Integer, ForeignKey("affiliate_accounts.id"), nullable=True, index=True)
    platform_id = Column(Integer, ForeignKey("affiliate_platforms.id"), nullable=True, index=True)  # 联盟平台ID（用于谷歌广告数据）
    upload_type = Column(Enum(UploadType), nullable=False)
    file_name = Column(String(255), nullable=False)
    file_path = Column(String(500), nullable=False)
    upload_date = Column(Date, nullable=False)  # 数据日期（前7天中的某一天）
    uploaded_at = Column(DateTime(timezone=True), server_default=func.now())
    status = Column(Enum(UploadStatus), default=UploadStatus.PENDING, nullable=False)
    
    # 关系
    user = relationship("User", back_populates="data_uploads")
    affiliate_account = relationship("AffiliateAccount", back_populates="data_uploads")
    platform = relationship("AffiliatePlatform", foreign_keys=[platform_id])




