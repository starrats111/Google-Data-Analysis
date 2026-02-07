"""
AI 报告和用户提示词模型
"""
from sqlalchemy import Column, Integer, String, Text, DateTime, ForeignKey
from datetime import datetime

from app.database import Base


class AIReport(Base):
    """AI 生成的分析报告"""
    __tablename__ = "ai_reports"
    
    id = Column(Integer, primary_key=True, index=True)
    user_id = Column(Integer, ForeignKey("users.id"), nullable=False)
    analysis_result_id = Column(Integer, nullable=True)
    content = Column(Text, nullable=False)
    campaign_count = Column(Integer, default=0)
    created_at = Column(DateTime, default=datetime.utcnow)


class UserPrompt(Base):
    """用户自定义提示词"""
    __tablename__ = "user_prompts"
    
    id = Column(Integer, primary_key=True, index=True)
    user_id = Column(Integer, ForeignKey("users.id"), nullable=False, unique=True)
    prompt = Column(Text, nullable=False)
    updated_at = Column(DateTime, default=datetime.utcnow, onupdate=datetime.utcnow)

