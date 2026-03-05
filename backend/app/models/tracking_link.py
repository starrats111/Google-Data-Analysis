"""
追踪链接历史（OPT-012）
"""
from sqlalchemy import Column, Integer, String, Text, DateTime, ForeignKey, Index
from sqlalchemy.orm import relationship
from sqlalchemy.sql import func
from app.database import Base


class PubTrackingLink(Base):
    __tablename__ = "pub_tracking_links"

    id = Column(Integer, primary_key=True, autoincrement=True)
    user_id = Column(Integer, ForeignKey("users.id"), nullable=False)
    merchant_url = Column(String(500), nullable=False)
    tracking_link = Column(Text, nullable=False)
    brand_name = Column(String(200), nullable=True)
    created_at = Column(DateTime(timezone=True), server_default=func.now())

    user = relationship("User", backref="pub_tracking_links")

    __table_args__ = (
        Index("idx_pub_tracking_links_user", "user_id"),
        Index("idx_pub_tracking_links_domain", "merchant_url"),
    )
