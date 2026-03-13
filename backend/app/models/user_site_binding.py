"""
用户-网站绑定关联表（CR-008）
多对多关系：一个用户可绑定多个网站，一个网站可被多人绑定
"""
from sqlalchemy import Column, Integer, ForeignKey, DateTime, UniqueConstraint, Index
from sqlalchemy.sql import func
from app.database import Base


class UserSiteBinding(Base):
    __tablename__ = "user_site_bindings"

    id = Column(Integer, primary_key=True, autoincrement=True)
    user_id = Column(Integer, ForeignKey("users.id"), nullable=False)
    site_id = Column(Integer, ForeignKey("pub_sites.id"), nullable=False)
    created_at = Column(DateTime(timezone=True), server_default=func.now())

    __table_args__ = (
        UniqueConstraint("user_id", "site_id", name="uq_user_site"),
        Index("idx_usb_user", "user_id"),
        Index("idx_usb_site", "site_id"),
    )
