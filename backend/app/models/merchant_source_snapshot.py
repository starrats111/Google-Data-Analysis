"""
商家源数据快照（P2 审计）
记录商家 API 返回快照，便于追责与回放。
"""
from sqlalchemy import Column, Integer, String, Text, Date, DateTime, Index
from sqlalchemy.sql import func
from app.database import Base


class MerchantSourceSnapshot(Base):
    __tablename__ = "merchant_source_snapshots"

    id = Column(Integer, primary_key=True, index=True)
    platform = Column(String(32), nullable=False, index=True)
    source_api = Column(String(32), nullable=False)
    source_key = Column(String(128), nullable=False, index=True)
    raw_payload = Column(Text, nullable=True)
    snapshot_date = Column(Date, nullable=False, index=True)
    created_at = Column(DateTime(timezone=True), server_default=func.now())

    __table_args__ = (
        Index("idx_snapshot_platform_key_date", "platform", "source_key", "snapshot_date"),
    )
