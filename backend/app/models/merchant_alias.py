"""
商家别名映射（P1 数据治理）
解决同商家多写法（大小写、空格、符号差异）导致的重复发现。
"""
from sqlalchemy import Column, Integer, String, ForeignKey, DateTime, Index
from sqlalchemy.sql import func
from app.database import Base


class MerchantAlias(Base):
    __tablename__ = "merchant_aliases"

    id = Column(Integer, primary_key=True, index=True)
    platform = Column(String(32), nullable=False, index=True)
    alias_name = Column(String(200), nullable=False)
    normalized_name = Column(String(200), nullable=False, index=True)
    merchant_id_ref = Column(Integer, ForeignKey("affiliate_merchants.id", ondelete="CASCADE"), nullable=True, index=True)
    source = Column(String(16), nullable=False, default="auto", server_default="auto")
    created_at = Column(DateTime(timezone=True), server_default=func.now())

    __table_args__ = (
        Index("idx_alias_platform_alias", "platform", "alias_name", unique=True),
    )
