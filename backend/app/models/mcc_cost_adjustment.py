"""
MCC费用手动调整模型
用于手动上传某段时间MCC的费用
"""
from sqlalchemy import Column, Integer, Date, DateTime, ForeignKey, Float, UniqueConstraint
from sqlalchemy.orm import relationship
from sqlalchemy.sql import func
from app.database import Base


class MccCostAdjustment(Base):
    """MCC费用手动调整"""
    __tablename__ = "mcc_cost_adjustments"

    id = Column(Integer, primary_key=True, index=True)
    user_id = Column(Integer, ForeignKey("users.id", ondelete="CASCADE"), nullable=False, index=True)
    mcc_id = Column(Integer, ForeignKey("google_mcc_accounts.id", ondelete="CASCADE"), nullable=False, index=True)
    date = Column(Date, nullable=False, index=True)
    
    manual_cost = Column(Float, default=0.0, nullable=False)  # 手动上传的费用（覆盖Google Ads API数据）

    created_at = Column(DateTime(timezone=True), server_default=func.now())
    updated_at = Column(DateTime(timezone=True), onupdate=func.now())

    __table_args__ = (
        UniqueConstraint("user_id", "mcc_id", "date", name="uq_mcc_cost_adj_user_mcc_date"),
    )

    user = relationship("User")
    mcc_account = relationship("GoogleMccAccount")

