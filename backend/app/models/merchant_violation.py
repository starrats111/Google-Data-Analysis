"""
商家违规记录模型
"""
from sqlalchemy import Column, Integer, String, DateTime, Text, Index
from sqlalchemy.sql import func
from app.database import Base


class MerchantViolation(Base):
    """商家违规记录 — 从 Excel 上传导入"""
    __tablename__ = "merchant_violations"

    id = Column(Integer, primary_key=True, index=True)
    mcid = Column(String(200), nullable=True, index=True)
    merchant_mid = Column(String(64), nullable=True, index=True)
    merchant_name = Column(String(200), nullable=False)
    platform = Column(String(32), nullable=False, index=True)
    merchant_url = Column(String(500), nullable=True)
    violation_reason = Column(Text, nullable=True)  # 违规原因
    violation_time = Column(DateTime(timezone=True), nullable=True)
    upload_batch = Column(String(64), nullable=False, index=True)
    created_at = Column(DateTime(timezone=True), server_default=func.now())

    __table_args__ = (
        Index("idx_violation_mcid_platform", "mcid", "platform"),
        Index("idx_violation_mid_platform", "merchant_mid", "platform"),
    )
