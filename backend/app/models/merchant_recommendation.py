"""
推荐商家记录模型
"""
from sqlalchemy import Column, Integer, String, DateTime, Text, Numeric, Index
from sqlalchemy.sql import func
from app.database import Base


class MerchantRecommendation(Base):
    """推荐商家记录 — 从 BU 推荐 Excel 上传导入"""
    __tablename__ = "merchant_recommendations"

    id = Column(Integer, primary_key=True, index=True)
    mcid = Column(String(200), nullable=True, index=True)
    merchant_mid = Column(String(64), nullable=True, index=True)
    merchant_name = Column(String(200), nullable=False)
    platform = Column(String(32), nullable=True)
    merchant_url = Column(String(500), nullable=True)
    merchant_region = Column(String(100), nullable=True)
    epc = Column(Numeric(12, 4), nullable=True)
    commission_cap = Column(Numeric(12, 4), nullable=True)
    avg_commission_rate = Column(Numeric(12, 10), nullable=True)
    avg_order_commission = Column(Numeric(12, 4), nullable=True)
    upload_batch = Column(String(64), nullable=False, index=True)
    created_at = Column(DateTime(timezone=True), server_default=func.now())

    __table_args__ = (
        Index("idx_recommend_mcid", "mcid"),
        Index("idx_recommend_mid", "merchant_mid"),
    )
