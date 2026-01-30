"""
分析结果模型
"""
from sqlalchemy import Column, Integer, Date, DateTime, ForeignKey, JSON
from sqlalchemy.orm import relationship
from sqlalchemy.sql import func
from app.database import Base


class AnalysisResult(Base):
    __tablename__ = "analysis_results"
    
    id = Column(Integer, primary_key=True, index=True)
    user_id = Column(Integer, ForeignKey("users.id"), nullable=False, index=True)
    affiliate_account_id = Column(Integer, ForeignKey("affiliate_accounts.id"), nullable=True, index=True)
    upload_id_google = Column(Integer, ForeignKey("data_uploads.id"), nullable=True)
    upload_id_affiliate = Column(Integer, ForeignKey("data_uploads.id"), nullable=True)
    analysis_date = Column(Date, nullable=False, index=True)
    result_data = Column(JSON, nullable=False)  # 存储分析结果（表3的数据）
    created_at = Column(DateTime(timezone=True), server_default=func.now())
    
    # 关系
    user = relationship("User", back_populates="analysis_results")
    affiliate_account = relationship("AffiliateAccount", back_populates="analysis_results")














