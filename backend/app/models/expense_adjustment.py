"""
费用/佣金调整（拒付佣金）模型
"""
from sqlalchemy import Column, Integer, Date, DateTime, ForeignKey, Float, UniqueConstraint
from sqlalchemy.orm import relationship
from sqlalchemy.sql import func
from app.database import Base


class ExpenseAdjustment(Base):
    """员工按平台/日期录入的拒付佣金等调整项"""
    __tablename__ = "expense_adjustments"

    id = Column(Integer, primary_key=True, index=True)
    user_id = Column(Integer, ForeignKey("users.id", ondelete="CASCADE"), nullable=False, index=True)
    platform_id = Column(Integer, ForeignKey("affiliate_platforms.id"), nullable=False, index=True)
    date = Column(Date, nullable=False, index=True)

    rejected_commission = Column(Float, default=0.0, nullable=False)  # 拒付佣金
    manual_cost = Column(Float, default=0.0, nullable=False)  # 手动上传的费用（覆盖Google Ads API数据）

    created_at = Column(DateTime(timezone=True), server_default=func.now())
    updated_at = Column(DateTime(timezone=True), onupdate=func.now())

    __table_args__ = (
        UniqueConstraint("user_id", "platform_id", "date", name="uq_expense_adj_user_platform_date"),
    )

    user = relationship("User")
    platform = relationship("AffiliatePlatform")


