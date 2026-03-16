"""
员工违规上报记录模型
"""
from sqlalchemy import Column, Integer, String, DateTime, Text
from sqlalchemy.sql import func
from app.database import Base


class ViolationReport(Base):
    """员工提交的违规上报，需 leader 审核"""
    __tablename__ = "violation_reports"

    id = Column(Integer, primary_key=True, index=True)
    reporter_id = Column(Integer, nullable=False, index=True)       # 上报人 user_id
    merchant_name = Column(String(200), nullable=False)
    mcid = Column(String(200), nullable=True)
    merchant_mid = Column(String(64), nullable=True)
    platform = Column(String(32), nullable=True)
    merchant_url = Column(String(500), nullable=True)
    reason = Column(Text, nullable=False)                           # 违规原因
    status = Column(String(20), default="pending", nullable=False, index=True)  # pending / approved / rejected
    reviewer_id = Column(Integer, nullable=True)                    # 审核人 user_id
    review_comment = Column(Text, nullable=True)
    reviewed_at = Column(DateTime(timezone=True), nullable=True)
    created_at = Column(DateTime(timezone=True), server_default=func.now())
