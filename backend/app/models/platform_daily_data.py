"""
平台每日数据模型
从平台API自动获取的佣金和订单数据
"""
from sqlalchemy import Column, Integer, String, Date, DateTime, Float, ForeignKey, UniqueConstraint, Index
from sqlalchemy.orm import relationship
from sqlalchemy.sql import func
from app.database import Base


class PlatformDailyData(Base):
    """平台每日数据"""
    __tablename__ = "platform_daily_data"
    
    id = Column(Integer, primary_key=True, index=True)
    
    # 关联信息
    user_id = Column(Integer, ForeignKey("users.id", ondelete="CASCADE"), nullable=False, index=True)
    affiliate_account_id = Column(Integer, ForeignKey("affiliate_accounts.id", ondelete="CASCADE"), nullable=False, index=True)
    platform_id = Column(Integer, ForeignKey("affiliate_platforms.id"), nullable=False, index=True)
    
    # 日期
    date = Column(Date, nullable=False, index=True)
    
    # 平台数据
    commission = Column(Float, default=0.0, nullable=False)  # 佣金
    orders = Column(Integer, default=0, nullable=False)  # 订单数
    week_order_days = Column(Integer, default=0, nullable=False)  # 本周出单天数（从周一到周日）
    
    # 元数据
    last_sync_at = Column(DateTime(timezone=True), nullable=True)  # 最后同步时间
    created_at = Column(DateTime(timezone=True), server_default=func.now())
    updated_at = Column(DateTime(timezone=True), onupdate=func.now())
    
    __table_args__ = (
        UniqueConstraint("affiliate_account_id", "date", name="uq_platform_daily_account_date"),
        Index("idx_platform_daily_user_date", "user_id", "date"),
        Index("idx_platform_daily_platform_date", "platform_id", "date"),
    )
    
    user = relationship("User")
    affiliate_account = relationship("AffiliateAccount")
    platform = relationship("AffiliatePlatform")


