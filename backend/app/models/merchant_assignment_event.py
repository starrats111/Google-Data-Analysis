"""
分配事件审计（P2 审计）
记录创建/转移/取消/完成，支持审核追踪。
"""
from sqlalchemy import Column, Integer, String, Text, DateTime, ForeignKey
from sqlalchemy.sql import func
from app.database import Base


class MerchantAssignmentEvent(Base):
    __tablename__ = "merchant_assignment_events"

    id = Column(Integer, primary_key=True, index=True)
    assignment_id = Column(Integer, ForeignKey("merchant_assignments.id", ondelete="CASCADE"), nullable=False, index=True)
    event_type = Column(String(20), nullable=False, index=True)  # created / transferred / cancelled / completed / updated
    old_value = Column(Text, nullable=True)
    new_value = Column(Text, nullable=True)
    operator_id = Column(Integer, ForeignKey("users.id"), nullable=True, index=True)
    created_at = Column(DateTime(timezone=True), server_default=func.now())
