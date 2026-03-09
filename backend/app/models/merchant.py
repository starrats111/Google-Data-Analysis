"""
商家目录与任务分配模型
"""
from sqlalchemy import (
    Column, Integer, String, DateTime, Numeric, Text,
    ForeignKey, UniqueConstraint, Index
)
from sqlalchemy.orm import relationship
from sqlalchemy.sql import func
from app.database import Base


class AffiliateMerchant(Base):
    """商家目录 — 从各平台交易数据中自动发现并注册"""
    __tablename__ = "affiliate_merchants"

    id = Column(Integer, primary_key=True, index=True)
    merchant_id = Column(String(64), nullable=True, index=True)
    merchant_name = Column(String(200), nullable=False)
    platform = Column(String(32), nullable=False, index=True)
    slug = Column(String(200), nullable=True)
    category = Column(String(100), nullable=True)
    commission_rate = Column(String(50), nullable=True)
    logo_url = Column(String(500), nullable=True)
    status = Column(String(20), default="active", nullable=False, index=True)
    notes = Column(Text, nullable=True)
    missing_mid = Column(Integer, default=0, nullable=False, index=True)
    id_confidence = Column(String(16), default="high", nullable=False, server_default="high")
    source_type = Column(String(16), default="transaction", nullable=False, server_default="transaction")
    relationship_status = Column(String(20), nullable=True, index=True)
    created_at = Column(DateTime(timezone=True), server_default=func.now())
    updated_at = Column(DateTime(timezone=True), onupdate=func.now())

    # OPT-014: 平台同步下架检测
    last_seen_at = Column(DateTime(timezone=True), nullable=True)
    consecutive_misses = Column(Integer, default=0, nullable=False, server_default="0")

    # 违规标记
    violation_status = Column(String(20), default="normal", nullable=False, server_default="normal")
    violation_time = Column(DateTime(timezone=True), nullable=True)

    # 推荐标记
    recommendation_status = Column(String(20), default="normal", nullable=False, server_default="normal")
    recommendation_time = Column(DateTime(timezone=True), nullable=True)

    assignments = relationship("MerchantAssignment", back_populates="merchant", cascade="all, delete-orphan")

    __table_args__ = (
        UniqueConstraint("platform", "merchant_id", name="uq_merchant_platform_mid"),
        Index("idx_merchant_name", "merchant_name"),
    )


class MerchantAssignment(Base):
    """商家任务分配 — 管理者将商家分配给员工"""
    __tablename__ = "merchant_assignments"

    id = Column(Integer, primary_key=True, index=True)
    merchant_id = Column(Integer, ForeignKey("affiliate_merchants.id", ondelete="CASCADE"), nullable=False, index=True)
    user_id = Column(Integer, ForeignKey("users.id", ondelete="CASCADE"), nullable=False, index=True)
    assigned_by = Column(Integer, ForeignKey("users.id"), nullable=False)
    status = Column(String(20), default="active", nullable=False, index=True)
    priority = Column(String(10), default="normal", nullable=False)
    monthly_target = Column(Numeric(12, 2), nullable=True)
    notes = Column(Text, nullable=True)
    assigned_at = Column(DateTime(timezone=True), server_default=func.now())
    completed_at = Column(DateTime(timezone=True), nullable=True)
    created_at = Column(DateTime(timezone=True), server_default=func.now())
    updated_at = Column(DateTime(timezone=True), onupdate=func.now())

    merchant = relationship("AffiliateMerchant", back_populates="assignments")
    user = relationship("User", foreign_keys=[user_id])
    assigner = relationship("User", foreign_keys=[assigned_by])

    __table_args__ = (
        UniqueConstraint("merchant_id", "user_id", "status", name="uq_assignment_merchant_user_status"),
        Index("idx_assignment_user_status", "user_id", "status"),
    )
