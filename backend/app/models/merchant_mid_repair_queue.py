"""
MID 补偿队列（P0）
"""
from sqlalchemy import Column, Integer, String, Text, DateTime, Numeric, Index
from sqlalchemy.sql import func
from app.database import Base


class MerchantMidRepairQueue(Base):
    __tablename__ = "merchant_mid_repair_queue"

    id = Column(Integer, primary_key=True, index=True)
    platform = Column(String(32), nullable=False, index=True)
    merchant_name = Column(String(200), nullable=False, index=True)
    slug = Column(String(200), nullable=True)
    latest_tx_time = Column(DateTime(timezone=True), nullable=True)
    candidate_mid = Column(String(64), nullable=True)
    repair_status = Column(String(20), nullable=False, default="pending", server_default="pending", index=True)
    confidence_score = Column(Numeric(5, 2), nullable=True)
    attempts = Column(Integer, nullable=False, default=0, server_default="0")
    next_retry_at = Column(DateTime(timezone=True), nullable=True, index=True)
    resolved_mid = Column(String(64), nullable=True)
    resolved_by = Column(Integer, nullable=True)
    resolved_at = Column(DateTime(timezone=True), nullable=True)
    reason = Column(Text, nullable=True)
    created_at = Column(DateTime(timezone=True), server_default=func.now())
    updated_at = Column(DateTime(timezone=True), onupdate=func.now())

    __table_args__ = (
        Index("idx_repair_platform_name", "platform", "merchant_name"),
    )
