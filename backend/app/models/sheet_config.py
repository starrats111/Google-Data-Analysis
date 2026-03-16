"""
共享表格链接配置模型
"""
from sqlalchemy import Column, Integer, String, DateTime, Text
from sqlalchemy.sql import func
from app.database import Base


class SheetConfig(Base):
    """存储违规/推荐共享表格链接"""
    __tablename__ = "sheet_configs"

    id = Column(Integer, primary_key=True, index=True)
    config_type = Column(String(32), nullable=False, unique=True, index=True)  # violation / recommendation
    sheet_url = Column(Text, nullable=False)
    last_synced_at = Column(DateTime(timezone=True), nullable=True)
    updated_by = Column(Integer, nullable=True)
    created_at = Column(DateTime(timezone=True), server_default=func.now())
    updated_at = Column(DateTime(timezone=True), onupdate=func.now())
