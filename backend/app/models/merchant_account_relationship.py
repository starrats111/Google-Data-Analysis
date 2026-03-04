"""
商家-账号申请关系表（OPT-009）
记录每个（商家, 联盟账号）维度的平台关系状态。
"""
from sqlalchemy import (
    Column, Integer, String, DateTime, ForeignKey, UniqueConstraint, Index,
)
from sqlalchemy.orm import relationship
from sqlalchemy.sql import func
from app.database import Base


class MerchantAccountRelationship(Base):
    __tablename__ = "merchant_account_relationships"

    id = Column(Integer, primary_key=True, index=True)
    merchant_id = Column(
        Integer,
        ForeignKey("affiliate_merchants.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )
    affiliate_account_id = Column(
        Integer,
        ForeignKey("affiliate_accounts.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )
    relationship_status = Column(String(20), nullable=False)  # joined / pending / rejected
    previous_status = Column(String(20), nullable=True)
    synced_at = Column(DateTime(timezone=True), nullable=True)
    created_at = Column(DateTime(timezone=True), server_default=func.now())
    updated_at = Column(DateTime(timezone=True), onupdate=func.now())

    merchant = relationship("AffiliateMerchant")
    affiliate_account = relationship("AffiliateAccount")

    __table_args__ = (
        UniqueConstraint("merchant_id", "affiliate_account_id", name="uq_mar_merchant_account"),
        Index("idx_mar_status", "relationship_status"),
    )
