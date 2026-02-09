"""
平台数据模型
存储从平台API同步的佣金、订单等数据
"""
from sqlalchemy import Column, Integer, String, Date, DateTime, ForeignKey, Float, Text, UniqueConstraint, Index
from sqlalchemy.orm import relationship
from sqlalchemy.sql import func
from app.database import Base


class PlatformData(Base):
    """平台数据模型"""
    __tablename__ = "platform_data"
    
    id = Column(Integer, primary_key=True, index=True)
    
    # 关联信息
    affiliate_account_id = Column(Integer, ForeignKey("affiliate_accounts.id", ondelete="CASCADE"), nullable=False, index=True)
    user_id = Column(Integer, ForeignKey("users.id", ondelete="CASCADE"), nullable=False, index=True)
    date = Column(Date, nullable=False, index=True)
    
    # 平台数据（统一数据模型：CG + RW）
    # 核心指标1-3：订单和佣金
    orders = Column(Integer, default=0, nullable=False)  # 总订单数
    approved_orders = Column(Integer, default=0, nullable=False)  # 已确认订单数
    commission = Column(Float, default=0.0, nullable=False)  # 总佣金（已确认）
    
    # 核心指标4-5：拒付数据
    rejected_orders = Column(Integer, default=0, nullable=False)  # 拒付订单数
    rejected_commission = Column(Float, default=0.0, nullable=False)  # 拒付佣金
    
    # 核心指标6：拒付率（计算字段，不存储）
    # rejected_rate = rejected_orders / orders
    
    # 辅助字段
    order_days_this_week = Column(Integer, default=0, nullable=False)  # 本周出单天数
    order_amount = Column(Float, default=0.0, nullable=False)  # 订单总金额（用于对账）
    
    # 订单详情（JSON格式存储，包含transaction_id用于去重）
    # 格式: [{"transaction_id": "...", "status": "...", "commission_amount": ..., ...}, ...]
    order_details = Column(Text, nullable=True)  # 存储订单列表JSON
    
    # 元数据
    last_sync_at = Column(DateTime(timezone=True), server_default=func.now())  # 最后同步时间
    created_at = Column(DateTime(timezone=True), server_default=func.now())
    updated_at = Column(DateTime(timezone=True), onupdate=func.now())
    
    __table_args__ = (
        UniqueConstraint("affiliate_account_id", "date", name="uq_platform_data_account_date"),
        Index("idx_platform_data_user_date", "user_id", "date"),
        Index("idx_platform_data_account_date", "affiliate_account_id", "date"),
    )
    
    affiliate_account = relationship("AffiliateAccount", back_populates="platform_data")
    user = relationship("User", overlaps="platform_data")


