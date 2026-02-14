"""
AI 报告和用户提示词模型
"""
from sqlalchemy import Column, Integer, String, Text, DateTime, ForeignKey

from app.database import Base
from app.middleware.auth import utc_now


class AIReport(Base):
    """AI 生成的分析报告"""
    __tablename__ = "ai_reports"
    
    id = Column(Integer, primary_key=True, index=True)
    user_id = Column(Integer, ForeignKey("users.id"), nullable=False)
    analysis_result_id = Column(Integer, nullable=True)
    content = Column(Text, nullable=False)
    campaign_count = Column(Integer, default=0)
    created_at = Column(DateTime, default=utc_now)


class UserPrompt(Base):
    """用户自定义提示词"""
    __tablename__ = "user_prompts"
    
    id = Column(Integer, primary_key=True, index=True)
    user_id = Column(Integer, ForeignKey("users.id"), nullable=False, index=True)
    prompt_type = Column(String(20), nullable=False, default="analysis", index=True)  # 'analysis' 或 'report'
    prompt = Column(Text, nullable=False)
    updated_at = Column(DateTime, default=utc_now, onupdate=utc_now)
    
    # user_id + prompt_type 组合唯一

