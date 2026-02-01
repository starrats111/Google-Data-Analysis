"""
数据字典模型
"""
from sqlalchemy import Column, Integer, String, Text, DateTime
from sqlalchemy.sql import func
from app.database import Base


class DataDictionary(Base):
    __tablename__ = "data_dictionary"
    
    id = Column(Integer, primary_key=True, index=True)
    field_name = Column(String(100), nullable=False, index=True)
    field_description = Column(Text, nullable=True)
    category = Column(String(50), nullable=True)
    created_at = Column(DateTime(timezone=True), server_default=func.now())


















