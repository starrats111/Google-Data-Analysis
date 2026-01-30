"""
MCC账号模型
管理多个Google Ads MCC账号
"""
from sqlalchemy import Column, Integer, String, DateTime, ForeignKey, Boolean, Text
from sqlalchemy.orm import relationship
from sqlalchemy.sql import func
from app.database import Base


class MccAccount(Base):
    """MCC账号"""
    __tablename__ = "mcc_accounts"
    
    id = Column(Integer, primary_key=True, index=True)
    
    # 关联信息
    user_id = Column(Integer, ForeignKey("users.id", ondelete="CASCADE"), nullable=False, index=True)
    
    # MCC账号信息
    mcc_account_id = Column(String(100), unique=True, nullable=False, index=True)  # MCC账号ID
    mcc_account_name = Column(String(255), nullable=True)  # MCC账号名称
    email = Column(String(255), nullable=True)  # 关联邮箱
    
    # Google Ads API配置
    refresh_token = Column(Text, nullable=True)  # OAuth刷新令牌
    client_id = Column(String(255), nullable=True)  # OAuth客户端ID
    client_secret = Column(String(255), nullable=True)  # OAuth客户端密钥
    developer_token = Column(String(255), nullable=True)  # 开发者令牌
    
    # 状态
    is_active = Column(Boolean, default=True, nullable=False)
    
    # 时间戳
    created_at = Column(DateTime(timezone=True), server_default=func.now())
    updated_at = Column(DateTime(timezone=True), onupdate=func.now())
    
    __table_args__ = (
        # 确保同一用户不能有重复的MCC账号ID
    )
    
    user = relationship("User")


