"""
网站发布配置模型（OPT-013）
"""
from sqlalchemy import (
    Column, Integer, String, Boolean, DateTime, ForeignKey, Index
)
from sqlalchemy.sql import func
from app.database import Base


class PubSite(Base):
    __tablename__ = "pub_sites"

    id = Column(Integer, primary_key=True, autoincrement=True)
    group_id = Column(Integer, nullable=False)
    site_name = Column(String(100), nullable=False)
    site_path = Column(String(300), nullable=False)
    domain = Column(String(200), nullable=True)
    data_js_path = Column(String(200), default="js/articles-index.js")
    article_template = Column(String(200), default="article-1.html")
    migrated = Column(Boolean, default=False)
    created_by = Column(Integer, ForeignKey("users.id"), nullable=False)
    created_at = Column(DateTime(timezone=True), server_default=func.now())
    updated_at = Column(DateTime(timezone=True), server_default=func.now(), onupdate=func.now())

    __table_args__ = (
        Index("idx_pub_sites_group", "group_id"),
        Index("idx_pub_sites_creator", "created_by"),
    )
