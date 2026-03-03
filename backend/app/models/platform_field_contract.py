"""
平台字段契约配置（P1 数据治理）
把"字段优先级"从代码常量提升为可配置数据。
"""
from sqlalchemy import Column, Integer, String, Boolean, Text, DateTime
from sqlalchemy.sql import func
from app.database import Base


class PlatformFieldContract(Base):
    __tablename__ = "platform_field_contracts"

    id = Column(Integer, primary_key=True, index=True)
    platform = Column(String(32), nullable=False, index=True, unique=True)
    api_type = Column(String(24), nullable=False, default="transaction", server_default="transaction")
    mid_priority_json = Column(Text, nullable=True)
    merchant_name_priority_json = Column(Text, nullable=True)
    numeric_only = Column(Boolean, nullable=False, default=True, server_default="1")
    enabled = Column(Boolean, nullable=False, default=True, server_default="1")
    version = Column(String(20), nullable=True, default="1.0")
    updated_at = Column(DateTime(timezone=True), onupdate=func.now())
