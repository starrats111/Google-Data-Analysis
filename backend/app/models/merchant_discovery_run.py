"""
商家发现任务运行日志（P0）
"""
from sqlalchemy import Column, Integer, String, Date, Text, DateTime
from sqlalchemy.sql import func
from app.database import Base


class MerchantDiscoveryRun(Base):
    __tablename__ = "merchant_discovery_runs"

    id = Column(Integer, primary_key=True, index=True)
    run_date = Column(Date, nullable=False, index=True)
    trigger_type = Column(String(16), nullable=False)  # scheduler / manual / retry
    total_tx = Column(Integer, nullable=False, default=0)
    tx_with_mid = Column(Integer, nullable=False, default=0)
    tx_missing_mid = Column(Integer, nullable=False, default=0)
    new_merchant_count = Column(Integer, nullable=False, default=0)
    new_missing_mid_count = Column(Integer, nullable=False, default=0)
    fallback_tx_count = Column(Integer, nullable=False, default=0)
    fallback_with_mid_count = Column(Integer, nullable=False, default=0)
    status = Column(String(16), nullable=False, default="success")  # success / failed / partial
    error_message = Column(Text, nullable=True)
    created_at = Column(DateTime(timezone=True), server_default=func.now())
