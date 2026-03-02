"""
拒付佣金快照模型（OPT-002）
用于检测本月/上月拒付佣金变动并生成通知
"""
from sqlalchemy import Column, Integer, String, DateTime, ForeignKey, Numeric, UniqueConstraint
from sqlalchemy.sql import func
from app.database import Base


class CommissionSnapshot(Base):
    __tablename__ = "commission_snapshots"

    id = Column(Integer, primary_key=True, index=True)
    user_id = Column(Integer, ForeignKey("users.id", ondelete="CASCADE"), nullable=False, index=True)
    snapshot_type = Column(String(20), nullable=False, index=True)  # current_month / previous_month
    period = Column(String(20), nullable=False, index=True)  # e.g. "2026-01"
    total_rejected = Column(Numeric(12, 2), default=0, nullable=False)
    checked_at = Column(DateTime(timezone=True), server_default=func.now())
    created_at = Column(DateTime(timezone=True), server_default=func.now())

    __table_args__ = (
        UniqueConstraint("user_id", "snapshot_type", "period", name="uq_commission_snapshot_user_type_period"),
    )
